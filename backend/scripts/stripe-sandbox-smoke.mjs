#!/usr/bin/env node
// Exercises the real Stripe sandbox with exactly the parameters the functions send (checkout-params.ts), then cleans up.
//
//   npm --prefix functions run build && node scripts/stripe-sandbox-smoke.mjs --sandbox [--keep] [--terms]
//
// Creates one throwaway customer, one Checkout Session per plan and one Customer Portal session, prints their URLs,
// then expires the sessions and deletes the customer (--keep leaves them so a test card can be used on the URLs).
// --terms adds the terms-of-service checkbox, which needs the ToS URL set in the Dashboard first.
// Sandbox-only: live keys are refused.
import { Stripe, fail, resolveKey } from './lib/stripe-env.mjs'
import { checkoutSessionParams, pickPortalConfiguration } from '../functions/lib/billing/checkout-params.js'
import { PRICE_LOOKUP, hostingOrigin } from '../functions/lib/config.js'

const args = process.argv.slice(2)
const stripe = new Stripe(resolveKey(args, { allowLive: false }), { maxNetworkRetries: 2, timeout: 20_000 })
const uid = `smoke_${Date.now().toString(36)}`

// The restricted checkout key has no Tax access (it must not); only a permission error is tolerated here, anything else is a real failure.
let tax = { status: 'unreadable' }
let registrations = []
try {
  tax = await stripe.tax.settings.retrieve()
  if (tax.status === 'active') registrations = (await stripe.tax.registrations.list({ status: 'active', limit: 100 })).data
} catch (err) {
  if (err.type !== 'StripePermissionError') throw err
  console.log('Stripe Tax is not readable with this key (expected for the restricted checkout key): automatic_tax stays off')
}
const automaticTax = tax.status === 'active' && registrations.length > 0
const termsConsent = args.includes('--terms')
console.log(`Stripe Tax ${tax.status}, ${registrations.length} active registration(s) → automatic_tax ${automaticTax ? 'ON' : 'off'} for this run (mirrors flags/global.automaticTax)`)

const customer = await stripe.customers.create({ email: `${uid}@example.com`, name: 'Smoke Test', metadata: { uid, faangin_smoke: '1' } })
const rows = []
const sessions = []
let failed = false
try {
  for (const plan of Object.keys(PRICE_LOOKUP)) {
    const price = (await stripe.prices.list({ lookup_keys: [PRICE_LOOKUP[plan]], active: true, limit: 1 })).data[0]
    if (!price) fail(`no active price for ${plan}; run: node scripts/stripe-setup.mjs catalog --sandbox`)
    try {
      const session = await stripe.checkout.sessions.create(checkoutSessionParams({ plan, uid, customer: customer.id, priceId: price.id, automaticTax, termsConsent }))
      sessions.push(session.id)
      rows.push({
        plan, session: session.id, mode: session.mode, status: session.status,
        total: `${(session.amount_total / 100).toFixed(2)} ${session.currency}`,
        tax: session.automatic_tax?.enabled ? (session.automatic_tax.status ?? 'enabled') : 'off',
        invoice: session.invoice_creation?.enabled ? 'one-off invoice' : session.mode === 'subscription' ? 'subscription invoices' : 'none',
        url: session.url
      })
    } catch (err) {
      failed = true
      rows.push({ plan, session: 'FAILED', mode: '', status: err.code ?? err.type ?? 'error', total: '', tax: '', invoice: '', url: err.message })
    }
  }
  console.table(rows.map(({ url, ...r }) => r))
  for (const r of rows) console.log(`${r.plan}: ${r.url}`)
  const configuration = pickPortalConfiguration((await stripe.billingPortal.configurations.list({ active: true, limit: 100 })).data)
  try {
    const portal = await stripe.billingPortal.sessions.create({ customer: customer.id, return_url: `${hostingOrigin()}/activate`, ...(configuration ? { configuration } : {}) })
    console.log(`portal (${configuration ?? 'Dashboard default'}): ${portal.url}`)
  } catch (err) {
    failed = true
    console.log(`portal: FAILED ${err.message}`)
  }
} finally {
  if (args.includes('--keep')) {
    console.log(`kept customer ${customer.id} and ${sessions.length} open session(s) (--keep); expire them from the Dashboard when done`)
  } else {
    for (const id of sessions) await stripe.checkout.sessions.expire(id).catch(() => undefined)
    await stripe.customers.del(customer.id).catch(() => undefined)
    console.log(`cleaned up: ${sessions.length} session(s) expired, customer ${customer.id} deleted`)
  }
}
if (failed) process.exit(1)
