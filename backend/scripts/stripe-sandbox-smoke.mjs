#!/usr/bin/env node
// Exercises the real Stripe sandbox with exactly the parameters the Supabase service sends (checkout-params.ts), then cleans up.
//
//   node --experimental-strip-types scripts/stripe-sandbox-smoke.mjs --sandbox [--terms]
//
// Creates one throwaway customer, one Checkout Session per plan and one Customer Portal session,
// then expires the sessions and deletes the customer. Complete payments through a real desktop account instead.
// --terms adds the terms-of-service checkbox, which needs the ToS URL set in the Dashboard first.
// Sandbox-only: live keys are refused.
import { createStripeClient, fail } from './lib/stripe-env.mjs'
import { checkoutSessionParams, pickPortalConfiguration } from '../supabase/checkout-params.ts'
import { PRICE_LOOKUP } from '../supabase/config.ts'

const args = process.argv.slice(2)
if (args.includes('--keep')) fail('--keep is no longer supported; use the desktop account flow for completed payments')
const hostingOrigin = process.env.FAANGIN_HOSTING_ORIGIN || 'https://uxgphdpcgcpgwbwfibkx.supabase.co/functions/v1/billing-return'
const origin = new URL(hostingOrigin)
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) fail('FAANGIN_HOSTING_ORIGIN must be an HTTPS billing-return base URL')
const { stripe } = await createStripeClient(args, { allowLive: false })
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
console.log(`Stripe Tax ${tax.status}, ${registrations.length} active registration(s) → automatic_tax ${automaticTax ? 'ON' : 'off'} for this run (mirrors the global automaticTax flag)`)

const customer = await stripe.customers.create({ email: `${uid}@example.com`, name: 'Smoke Test', metadata: { uid, faangin_smoke: '1' } })
const rows = []
const sessions = []
let failed = false
try {
  for (const plan of Object.keys(PRICE_LOOKUP)) {
    const price = (await stripe.prices.list({ lookup_keys: [PRICE_LOOKUP[plan]], active: true, limit: 1 })).data[0]
    if (!price) throw new Error(`no active price for ${plan}; run: node scripts/stripe-setup.mjs catalog --sandbox`)
    try {
      const session = await stripe.checkout.sessions.create(checkoutSessionParams({ plan, uid, customer: customer.id, priceId: price.id, hostingOrigin, automaticTax, termsConsent }))
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
  const configuration = pickPortalConfiguration((await stripe.billingPortal.configurations.list({ active: true, limit: 100 })).data)
  try {
    if (!configuration) throw new Error('No active portal configuration tagged faangin=v1; run the portal setup command')
    const portal = await stripe.billingPortal.sessions.create({ customer: customer.id, return_url: `${hostingOrigin}/activate`, configuration })
    console.log(`portal (${configuration}): session created (temporary URL withheld)`)
  } catch (err) {
    failed = true
    console.log(`portal: FAILED ${err.message}`)
  }
} finally {
  let cleanupFailed = false
  for (const id of sessions) {
    try { await stripe.checkout.sessions.expire(id) }
    catch { cleanupFailed = true; console.error(`cleanup failed for Checkout ${id}; expire it in the sandbox Dashboard`) }
  }
  try { await stripe.customers.del(customer.id) }
  catch { cleanupFailed = true; console.error(`cleanup failed for customer ${customer.id}; delete it in the sandbox Dashboard`) }
  if (cleanupFailed) failed = true
  else console.log(`cleaned up: ${sessions.length} session(s) expired, customer ${customer.id} deleted`)
}
if (failed) process.exit(1)
