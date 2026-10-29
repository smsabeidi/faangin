#!/usr/bin/env node
// Idempotent Stripe setup for one environment (sandbox or live). Safe to re-run: it creates what is missing, updates
// what drifted, and never deletes. Prints ids, never keys.
//
//   node scripts/stripe-setup.mjs status                       account, Tax status, catalog, portal, webhooks
//   node scripts/stripe-setup.mjs catalog                      products + prices with lookup keys, tax codes, tax behavior
//   node scripts/stripe-setup.mjs tax-defaults                 account default tax_behavior/tax_code (head office stays an owner step)
//   node scripts/stripe-setup.mjs portal [--return-url U] [--privacy-url U] [--terms-url U]
//   node scripts/stripe-setup.mjs webhook --url URL [--secret-out FILE] [--disabled]   endpoint pinned to the SDK's API version
//
// Key: STRIPE_SECRET_KEY in the environment, or --sandbox to read STRIPE_SANDBOX_SECRET_KEY from .env.stripe-sandbox
// (gitignored). Live keys are refused unless --live is also passed.
import { closeSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { API_VERSION, Stripe, fail, keyMode, resolveKey } from './lib/stripe-env.mjs'

// Product catalog. Lookup keys are the contract with functions/src/config.ts; amounts come from the pricing decision
// of 2026-10-27 (BYOK $10 one-time, Pro $14.99/month or $144/year). USD, tax added on top (exclusive).
// Tax codes: txcd_10202000 "Downloadable Software - personal use" for the Mac app license,
// txcd_10103000 "Software as a service (SaaS) - personal use" for Pro. Confirm with a tax advisor before live.
export const CATALOG = [
  {
    key: 'byok',
    product: {
      name: 'Faangin BYOK license',
      description: 'Faangin for Mac with your own OpenAI key. One-time purchase, 3 Macs.',
      tax_code: 'txcd_10202000',
      statement_descriptor: 'FAANGIN BYOK'
    },
    prices: [{ lookup_key: 'faangin_byok_v1', unit_amount: 1000, currency: 'usd', tax_behavior: 'exclusive', nickname: 'BYOK $10 one-time' }]
  },
  {
    key: 'pro',
    product: {
      name: 'Faangin Pro',
      description: 'Everything included: transcription and answers through Faangin, nothing to configure, 3 Macs.',
      tax_code: 'txcd_10103000',
      statement_descriptor: 'FAANGIN PRO'
    },
    prices: [
      { lookup_key: 'faangin_pro_monthly', unit_amount: 1499, currency: 'usd', recurring: { interval: 'month' }, tax_behavior: 'exclusive', nickname: 'Pro $14.99/month' },
      { lookup_key: 'faangin_pro_annual', unit_amount: 14400, currency: 'usd', recurring: { interval: 'year' }, tax_behavior: 'exclusive', nickname: 'Pro $144/year' }
    ]
  }
]

/** Exactly the events stripeWebhook acts on (fulfill.ts) plus async_payment_failed and invoice.finalization_failed, which it logs. Nothing else is subscribed. */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.finalization_failed',
  'charge.refunded',
  'charge.dispute.created',
  'radar.early_fraud_warning.created'
]

/** Customer Portal: self-service that cannot be abused to reset metered allowances (no plan switching). */
export const PORTAL = {
  metadata: { faangin: 'v1' },
  name: 'Faangin customers',
  features: {
    customer_update: { enabled: true, allowed_updates: ['email', 'name', 'address', 'tax_id'] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: {
      enabled: true, mode: 'at_period_end', proration_behavior: 'none',
      cancellation_reason: { enabled: true, options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'too_complex', 'low_quality', 'other'] }
    },
    subscription_update: { enabled: false }
  }
}

// ---------------------------------------------------------------------------------------------------------------
const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith('--')) ?? 'status'
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const has = (name) => args.includes(`--${name}`)

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

async function allPages(list) { const out = []; for await (const item of list) out.push(item); return out }

async function ensureCatalog(stripe) {
  const products = await allPages(stripe.products.list({ active: true, limit: 100 }))
  const result = []
  for (const entry of CATALOG) {
    let product = products.find((p) => p.metadata?.faangin_key === entry.key)
    if (!product) {
      product = await stripe.products.create({ ...entry.product, metadata: { faangin_key: entry.key } })
      console.log(`created product ${product.id} (${entry.key})`)
    } else {
      const drift = Object.entries(entry.product).filter(([k, v]) => !same(product[k], v))
      if (drift.length) {
        product = await stripe.products.update(product.id, Object.fromEntries(drift))
        console.log(`updated product ${product.id} (${entry.key}): ${drift.map(([k]) => k).join(', ')}`)
      }
    }
    for (const spec of entry.prices) {
      const { data: [existing] } = await stripe.prices.list({ lookup_keys: [spec.lookup_key], active: true, limit: 1 })
      const immutable = { unit_amount: spec.unit_amount, currency: spec.currency, recurring: spec.recurring ? { interval: spec.recurring.interval } : null, tax_behavior: spec.tax_behavior }
      let price = existing
      if (existing) {
        const current = { unit_amount: existing.unit_amount, currency: existing.currency, recurring: existing.recurring ? { interval: existing.recurring.interval } : null, tax_behavior: existing.tax_behavior }
        if (!same(current, immutable) || existing.product !== product.id) {
          // Prices are immutable: make a new one and move the lookup key over; the old price stays for existing subscriptions.
          price = await stripe.prices.create({ ...spec, product: product.id, transfer_lookup_key: true })
          console.log(`replaced price ${existing.id} with ${price.id} (${spec.lookup_key}) because it drifted: ${JSON.stringify(current)}`)
        } else if (existing.nickname !== spec.nickname) {
          price = await stripe.prices.update(existing.id, { nickname: spec.nickname })
        }
      } else {
        price = await stripe.prices.create({ ...spec, product: product.id })
        console.log(`created price ${price.id} (${spec.lookup_key})`)
      }
      result.push({ product: product.id, price: price.id, lookup_key: spec.lookup_key, amount: `${(spec.unit_amount / 100).toFixed(2)} ${spec.currency}`, interval: spec.recurring?.interval ?? 'one-time', tax_code: entry.product.tax_code, tax_behavior: spec.tax_behavior })
    }
    if (entry.key === 'pro' && product.default_price !== result.find((r) => r.lookup_key === 'faangin_pro_monthly')?.price) {
      await stripe.products.update(product.id, { default_price: result.find((r) => r.lookup_key === 'faangin_pro_monthly').price })
    }
  }
  console.table(result)
  return result
}

async function ensureTaxDefaults(stripe) {
  const settings = await stripe.tax.settings.retrieve()
  const wanted = { tax_behavior: 'exclusive', tax_code: 'txcd_10103000' }
  if (settings.defaults?.tax_behavior !== wanted.tax_behavior || settings.defaults?.tax_code !== wanted.tax_code) {
    await stripe.tax.settings.update({ defaults: wanted })
    console.log('tax defaults set: exclusive, txcd_10103000')
  }
  const after = await stripe.tax.settings.retrieve()
  console.log(`Stripe Tax status: ${after.status}${after.status_details?.pending ? ` (missing: ${after.status_details.pending.missing_fields.join(', ')} — owner sets the head office in Dashboard → Tax)` : ''}`)
}

async function ensurePortal(stripe) {
  const configs = await allPages(stripe.billingPortal.configurations.list({ active: true, limit: 100 }))
  let config = configs.find((c) => c.metadata?.faangin === 'v1')
  const business_profile = {
    headline: 'Faangin',
    ...(flag('privacy-url') ? { privacy_policy_url: flag('privacy-url') } : {}),
    ...(flag('terms-url') ? { terms_of_service_url: flag('terms-url') } : {})
  }
  const params = { ...PORTAL, business_profile, ...(flag('return-url') ? { default_return_url: flag('return-url') } : {}) }
  if (!config) {
    config = await stripe.billingPortal.configurations.create(params)
    console.log(`created portal configuration ${config.id}`)
  } else {
    config = await stripe.billingPortal.configurations.update(config.id, params)
    console.log(`updated portal configuration ${config.id}`)
  }
  console.log(`portal: is_default=${config.is_default} features=${Object.entries(config.features).filter(([, v]) => v.enabled).map(([k]) => k).join(', ')}`)
  console.log('createPortalSession picks this configuration by metadata.faangin=v1 (functions/src/billing/checkout.ts).')
  return config
}

async function ensureWebhook(stripe) {
  const url = flag('url')
  if (!url) fail('webhook needs --url https://.../stripeWebhook')
  const endpoints = await allPages(stripe.webhookEndpoints.list({ limit: 100 }))
  let endpoint = endpoints.find((e) => e.url === url)
  if (!endpoint) {
    const out = flag('secret-out')
    if (has('secret-out') && !out) fail('--secret-out needs a file path')
    // Reserve the file before creating anything: a bad directory, an existing file or a symlink fails now, not after the one-time secret exists.
    const fd = out ? openSync(out, 'wx', 0o600) : undefined
    try {
      endpoint = await stripe.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS, api_version: API_VERSION, description: 'Faangin stripeWebhook (Cloud Functions)' })
    } catch (err) {
      if (fd !== undefined) { closeSync(fd); unlinkSync(out) }
      throw err
    }
    if (has('disabled')) endpoint = await stripe.webhookEndpoints.update(endpoint.id, { disabled: true }) // until the function is deployed; enable in the Dashboard
    console.log(`created webhook endpoint ${endpoint.id} (api_version ${endpoint.api_version}, ${endpoint.enabled_events.length} events)`)
    if (fd !== undefined) {
      // Raw value, no newline: `npx firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --data-file <out>` takes the file verbatim.
      writeSync(fd, endpoint.secret)
      closeSync(fd)
      console.log(`signing secret written to ${out}; set it with: npx firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project <project> --data-file ${out}  (then delete the file)`)
    } else {
      console.log(`signing secret: ${endpoint.secret}`)
      console.log('(shown once because --secret-out was not given; roll it in the Dashboard if this output is logged anywhere)')
    }
  } else {
    const missing = WEBHOOK_EVENTS.filter((e) => !endpoint.enabled_events.includes(e))
    const extra = endpoint.enabled_events.filter((e) => !WEBHOOK_EVENTS.includes(e))
    if (missing.length || extra.length) {
      endpoint = await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: WEBHOOK_EVENTS })
      console.log(`updated webhook endpoint ${endpoint.id} events (+${missing.length} -${extra.length})`)
    }
    if (endpoint.api_version !== API_VERSION) console.warn(`warning: endpoint api_version is ${endpoint.api_version}, SDK is ${API_VERSION}; api_version cannot be changed after creation — recreate the endpoint to repin`)
    console.log(`webhook endpoint ${endpoint.id} is ${endpoint.status}; the signing secret is only shown at creation (Dashboard → Webhooks → Reveal)`)
  }
  return endpoint
}

async function status(stripe) {
  const account = await stripe.accounts.retrieve()
  console.log(`account ${account.id} "${account.settings?.dashboard?.display_name}" country=${account.country} currency=${account.default_currency}`)
  const tax = await stripe.tax.settings.retrieve()
  console.log(`Stripe Tax: ${tax.status} defaults=${JSON.stringify(tax.defaults)} head_office=${tax.head_office ? 'set' : 'MISSING'}`)
  const registrations = await allPages(stripe.tax.registrations.list({ limit: 100 }))
  console.log(`tax registrations: ${registrations.length}${registrations.length ? ' (' + registrations.map((r) => r.country + (r.country_options?.us?.state ? '/' + r.country_options.us.state : '')).join(', ') + ')' : ''}`)
  const prices = await allPages(stripe.prices.list({ active: true, limit: 100, expand: ['data.product'] }))
  console.table(prices.map((p) => ({ lookup_key: p.lookup_key, price: p.id, product: p.product.name, amount: `${(p.unit_amount / 100).toFixed(2)} ${p.currency}`, interval: p.recurring?.interval ?? 'one-time', tax_code: p.product.tax_code, tax_behavior: p.tax_behavior })))
  const expected = CATALOG.flatMap((c) => c.prices.map((p) => p.lookup_key))
  const missing = expected.filter((k) => !prices.some((p) => p.lookup_key === k))
  if (missing.length) console.log(`missing lookup keys: ${missing.join(', ')} (run: catalog)`)
  const portals = await allPages(stripe.billingPortal.configurations.list({ active: true, limit: 100 }))
  console.log(`portal configurations: ${portals.length}${portals.length ? ' (' + portals.map((c) => `${c.id}${c.is_default ? ' default' : ''}${c.metadata?.faangin ? ' faangin=' + c.metadata.faangin : ''}`).join(', ') + ')' : ' (run: portal)'}`)
  const endpoints = await allPages(stripe.webhookEndpoints.list({ limit: 100 }))
  for (const e of endpoints) console.log(`webhook ${e.id} ${e.status} api_version=${e.api_version} ${e.url} (${e.enabled_events.length} events)`)
  if (!endpoints.length) console.log('webhook endpoints: none (run: webhook --url ... after the functions are deployed)')
}

const key = resolveKey(args)
const stripe = new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000 })
console.log(`MODE: ${keyMode(key)}`)
const commands = { status, catalog: ensureCatalog, 'tax-defaults': ensureTaxDefaults, portal: ensurePortal, webhook: ensureWebhook }
if (!commands[command]) fail(`unknown command ${command}; one of ${Object.keys(commands).join(', ')}`)
await commands[command](stripe)
