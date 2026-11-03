import { readFileSync } from 'node:fs'
import { createPublicKey } from 'node:crypto'

const fields = new Set(['supabaseUrl', 'publishableKey', 'gatewayBase', 'licensePublicKeys'])

/** Public release metadata only. Credentials must stay in OS storage / Secret Manager. */
export function readCloudBuildConfig(path, { required = false } = {}) {
  if (!path) {
    if (required) throw new Error('Set FAANGIN_CLOUD_CONFIG_FILE to the public Supabase release configuration.')
    return undefined
  }
  let config
  try { config = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('The cloud build configuration must be a readable JSON file.') }
  if (!config || Array.isArray(config) || typeof config !== 'object' || Object.keys(config).some(key => !fields.has(key))) throw new Error('Cloud build configuration contains unsupported fields. Include public configuration only.')
  for (const field of ['supabaseUrl', 'gatewayBase']) {
    if (field === 'gatewayBase' && !config[field] && config.supabaseUrl) config[field] = `${config.supabaseUrl.replace(/\/+$/, '')}/functions/v1/faangin-gateway`
    let url
    try { url = new URL(config[field]) } catch { throw new Error(`Cloud build configuration requires ${field}.`) }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`${field} must be a public HTTPS endpoint without credentials or query parameters.`)
    if (field === 'supabaseUrl' && url.pathname !== '/') throw new Error(`${field} must be an HTTPS origin.`)
    if (field === 'gatewayBase' && (url.origin !== new URL(config.supabaseUrl).origin || url.pathname.replace(/\/+$/, '') !== '/functions/v1/faangin-gateway')) throw new Error('gatewayBase must be the faangin-gateway Edge Function on the configured Supabase project.')
    config[field] = url.href.replace(/\/+$/, '')
  }
  if (typeof config.publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey)) throw new Error('Cloud build configuration requires a Supabase publishable key. Server and legacy JWT keys must not ship in the app.')
  if (!Array.isArray(config.licensePublicKeys) || config.licensePublicKeys.length < 1 || config.licensePublicKeys.length > 3) throw new Error('Include one to three Ed25519 license public keys.')
  for (const key of config.licensePublicKeys) {
    try {
      if (typeof key !== 'string' || key.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) throw new Error()
      const parsed = createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' })
      if (parsed.asymmetricKeyType !== 'ed25519') throw new Error()
    } catch { throw new Error('License public keys must be base64 SPKI Ed25519 public keys.') }
  }
  return config
}
