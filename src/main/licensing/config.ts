export interface BuildCloudConfig {
  supabaseUrl: string
  publishableKey: string
  gatewayBase?: string
  licensePublicKeys?: readonly string[]
}

declare const __FAANGIN_CLOUD_CONFIG__: BuildCloudConfig
export const BUILD_CLOUD_CONFIG: BuildCloudConfig = typeof __FAANGIN_CLOUD_CONFIG__ === 'undefined'
  ? { supabaseUrl: '', publishableKey: '' }
  : __FAANGIN_CLOUD_CONFIG__

export interface CloudConfig extends BuildCloudConfig {
  /** All account operations share this explicitly authenticated Supabase Edge function. */
  functionsBase: string
}
export interface ResolveCloudConfigOptions {
  env?: Readonly<Record<string, string | undefined>>
  packaged: boolean
  build?: BuildCloudConfig
}
const trimSlash = (value: string): string => value.trim().replace(/\/+$/, '')
const isLoopback = (hostname: string): boolean => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'

/** Release builds embed public Supabase metadata; runtime endpoint overrides are development-only. */
export function resolveCloudConfig({ env = {}, packaged, build = BUILD_CLOUD_CONFIG }: ResolveCloudConfigOptions): CloudConfig | null {
  const override = (name: string): string | undefined => packaged ? undefined : env[name]?.trim() || undefined
  const supabaseUrl = trimSlash(override('FAANGIN_SUPABASE_URL') ?? build.supabaseUrl)
  const publishableKey = (override('FAANGIN_SUPABASE_PUBLISHABLE_KEY') ?? build.publishableKey).trim()
  if (!supabaseUrl || !publishableKey || !publishableKey.startsWith('sb_publishable_') || /\s/.test(publishableKey)) return null
  let origin: URL
  try { origin = new URL(supabaseUrl) } catch { return null }
  const local = isLoopback(origin.hostname)
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') return null
  if (local && packaged) return null
  if (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:')) return null
  const gatewayBase = trimSlash(override('FAANGIN_GATEWAY_BASE') ?? build.gatewayBase ?? '')
  if (gatewayBase) {
    let gateway: URL
    try { gateway = new URL(gatewayBase) } catch { return null }
    if (gateway.username || gateway.password || gateway.search || gateway.hash) return null
    if (gateway.protocol !== 'https:' && !(local && !packaged && isLoopback(gateway.hostname) && gateway.protocol === 'http:')) return null
    if (packaged && isLoopback(gateway.hostname)) return null
  }
  const keyOverride = override('FAANGIN_LICENSE_PUBLIC_KEYS')
  const licensePublicKeys = keyOverride ? keyOverride.split(',').map(key => key.trim()).filter(Boolean) : build.licensePublicKeys
  return { supabaseUrl, publishableKey, functionsBase: `${supabaseUrl}/functions/v1/faangin-api`, ...(gatewayBase ? { gatewayBase } : {}), ...(licensePublicKeys ? { licensePublicKeys } : {}) }
}

export type ExternalPurpose = 'checkout' | 'portal'
/** Activation is served by the main process. Only hosted Stripe billing links come from the backend. */
export function allowedExternalUrl(raw: string, _config: CloudConfig, purpose: ExternalPurpose): string | null {
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (url.username || url.password || url.protocol !== 'https:') return null
  return url.hostname === (purpose === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com') ? url.href : null
}
