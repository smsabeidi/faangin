// Use the user's approved CLI OAuth session without extracting its credential-store tokens.
// This adapter intentionally supports test-mode setup operations only.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
const redact = value => value.replace(/(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]+|whsec_[A-Za-z0-9_-]+/g, '[credential]')
export function formFields(value, prefix = '') {
  const result = []
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    const name = prefix ? `${prefix}[${key}]` : key
    if (item !== null && typeof item === 'object') result.push(...formFields(item, name))
    else result.push(`${name}=${item === null ? '' : String(item)}`)
  }
  return result
}
async function cli(args) {
  let output
  try { output = (await execute('stripe', args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout }
  catch (error) {
    // API errors can return JSON with nonzero status. Never include raw stdout in an exception.
    output = typeof error.stdout === 'string' ? error.stdout : ''
    if (!/^\{/m.test(output)) throw new Error('Stripe CLI request failed; verify its login, account permissions, and network access')
  }
  const start = output.search(/^\{/m)
  if (start < 0) throw new Error('Stripe CLI returned no JSON response')
  let result
  try { result = JSON.parse(output.slice(start)) } catch { throw new Error('Stripe CLI returned invalid JSON') }
  if (result.error) {
    const error = new Error(redact(String(result.error.message || 'Stripe API request failed')))
    error.code = result.error.code
    error.type = /permission/i.test(`${result.error.code} ${result.error.message}`) ? 'StripePermissionError' : result.error.type
    throw error
  }
  return result
}
export async function createCliStripe({ accountId, apiVersion, run = cli }) {
  if (!/^acct_[A-Za-z0-9]+$/.test(accountId || '')) throw new Error('--cli requires --expected-account acct_...')
  const identity = await run(['whoami', '--format', 'json'])
  if (identity.authorized !== true || identity.mode !== 'test' || identity.account_id !== accountId) throw new Error('Stripe CLI must be authorized in test mode for the exact expected account')
  async function request(method, path, parameters = {}) {
    const args = [method, path, '--color', 'off', '--stripe-version', apiVersion]
    if (method !== 'get') args.push('--confirm')
    for (const item of formFields(parameters)) args.push('-d', item)
    const result = await run(args)
    if (result.livemode === true || result.data?.some?.(item => item.livemode === true)) throw new Error('Refusing a live Stripe resource in test-mode setup')
    return result
  }
  function list(path, parameters = {}) {
    return {
      then: (resolve, reject) => request('get', path, parameters).then(resolve, reject),
      async *[Symbol.asyncIterator]() {
        let cursor = parameters.starting_after
        for (;;) {
          const page = await request('get', path, { ...parameters, ...(cursor ? { starting_after: cursor } : {}) })
          for (const item of page.data) yield item
          if (!page.has_more) return
          cursor = page.data.at(-1)?.id
          if (!cursor) throw new Error('Stripe pagination returned no continuation cursor')
        }
      }
    }
  }
  const resources = path => ({
    list: parameters => list(path, parameters),
    create: parameters => request('post', path, parameters),
    update: (id, parameters) => request('post', `${path}/${encodeURIComponent(id)}`, parameters)
  })
  return {
    accounts: { retrieve: () => request('get', '/v1/account') },
    products: resources('/v1/products'), prices: resources('/v1/prices'),
    tax: { settings: { retrieve: () => request('get', '/v1/tax/settings'), update: parameters => request('post', '/v1/tax/settings', parameters) }, registrations: resources('/v1/tax/registrations') },
    billingPortal: { configurations: resources('/v1/billing_portal/configurations'), sessions: resources('/v1/billing_portal/sessions') },
    webhookEndpoints: resources('/v1/webhook_endpoints'),
    customers: { ...resources('/v1/customers'), del: id => request('delete', `/v1/customers/${encodeURIComponent(id)}`) },
    checkout: { sessions: { ...resources('/v1/checkout/sessions'), expire: id => request('post', `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`) } }
  }
}
