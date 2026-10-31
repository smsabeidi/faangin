import { EMULATOR_IDENTITY_TOOLKIT_BASE, EMULATOR_SECURE_TOKEN_BASE } from '../faangin-cloud'

export interface BuildCloudConfig { functionsBase: string; webApiKey: string; hostingOrigin?: string }

/**
 * Where this build's accounts backend lives. A release build fills these in per environment, next to
 * LICENSE_PUBLIC_KEYS in ../faangin-cloud.ts (see backend/client/README.md). Empty values mean the build has no
 * backend, and the account section says so instead of offering sign-in.
 */
export const BUILD_CLOUD_CONFIG: BuildCloudConfig = { functionsBase: '', webApiKey: '' }

export interface CloudConfig {
  functionsBase: string
  /** Firebase web API key; public by design. */
  webApiKey: string
  hostingOrigin: string
  /** Set only for the local emulator suite. */
  identityToolkitBase?: string
  secureTokenBase?: string
}

export interface ResolveCloudConfigOptions {
  env?: Readonly<Record<string, string | undefined>>
  /** Packaged builds ignore the environment and never talk to a local emulator. */
  packaged: boolean
  build?: BuildCloudConfig
}

const trimSlash = (value: string): string => value.trim().replace(/\/+$/, '')
const isLoopback = (hostname: string): boolean => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'

/** https://us-central1-my-project.cloudfunctions.net → https://my-project.web.app; the emulator hosts on :5000. */
function deriveHostingOrigin(functions: URL): string | null {
  if (isLoopback(functions.hostname)) return 'http://localhost:5000'
  const project = /^[a-z]+-[a-z]+\d+-(.+)\.cloudfunctions\.net$/.exec(functions.hostname)?.[1]
  return project ? `https://${project}.web.app` : null
}

export function resolveCloudConfig({ env = {}, packaged, build = BUILD_CLOUD_CONFIG }: ResolveCloudConfigOptions): CloudConfig | null {
  const override = (name: string): string | undefined => (packaged ? undefined : env[name]?.trim() || undefined)
  const functionsBase = trimSlash(override('FAANGIN_FUNCTIONS_BASE') ?? build.functionsBase)
  const webApiKey = (override('FAANGIN_WEB_API_KEY') ?? build.webApiKey).trim()
  if (!functionsBase || !webApiKey) return null

  let functions: URL
  try { functions = new URL(functionsBase) } catch { return null }
  const local = isLoopback(functions.hostname)
  if (local && packaged) return null
  if (functions.protocol !== 'https:' && !(local && functions.protocol === 'http:')) return null

  const explicitHosting = override('FAANGIN_HOSTING_ORIGIN') ?? build.hostingOrigin
  const hostingOrigin = explicitHosting ? trimSlash(explicitHosting) : deriveHostingOrigin(functions)
  if (!hostingOrigin) return null
  let hosting: URL
  try { hosting = new URL(hostingOrigin) } catch { return null }
  if (hosting.protocol !== 'https:' && !(local && hosting.protocol === 'http:' && isLoopback(hosting.hostname))) return null

  return { functionsBase, webApiKey, hostingOrigin: hosting.origin, ...(local ? { identityToolkitBase: EMULATOR_IDENTITY_TOOLKIT_BASE, secureTokenBase: EMULATOR_SECURE_TOKEN_BASE } : {}) }
}

export type ExternalPurpose = 'activate' | 'checkout' | 'portal'

/**
 * Links come back from the server, so the app opens only the ones it expects: its own activation page, and
 * Stripe's hosted Checkout or Customer Portal. Anything else is refused (null).
 */
export function allowedExternalUrl(raw: string, config: CloudConfig, purpose: ExternalPurpose): string | null {
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (purpose === 'activate') return url.origin === config.hostingOrigin ? url.href : null
  if (url.protocol !== 'https:') return null
  return url.hostname === (purpose === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com') ? url.href : null
}
