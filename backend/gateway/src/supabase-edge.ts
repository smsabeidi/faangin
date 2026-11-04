/** Supabase Edge entrypoint: bundle with scripts/bundle-supabase.mjs. No Firebase initialization. */
import process from 'node:process'
import { createGateway } from './gateway.js'
import { createSupabaseBackend } from './supabase.js'
import { normalizeGatewayPath } from './supabase-routing.js'
import { OPENAI_BASE, OPENAI_WS_BASE } from './config.js'
import { resolveSupabaseServerKey } from './supabase-server-key.js'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined
const env = process.env
function keyMap(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try { const value = JSON.parse(raw); return typeof value.default === 'string' ? value.default : undefined } catch { return undefined }
}
const serviceKey = resolveSupabaseServerKey({ get: name => env[name] }, 'edge')
const publishableKey = keyMap(env.SUPABASE_PUBLISHABLE_KEYS) ?? env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY
if (!env.SUPABASE_URL || !serviceKey || !publishableKey) throw new Error('Supabase gateway configuration is incomplete')
const backend = createSupabaseBackend({ url: env.SUPABASE_URL, serviceKey, publishableKey })
const boot = Date.now()
const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...fields }))
const server = createGateway({ ...backend,
  openaiBase: OPENAI_BASE, openaiWsBase: OPENAI_WS_BASE,
  // Leave the service deployable while provider setup is pending; admission fails before any upstream call.
  openaiKey: env.OPENAI_API_KEY ?? '', providerReady: !!env.OPENAI_API_KEY,
  now: () => Date.now(), log, sessionExpiresAt: boot + 100_000, workerDeadlineAt: boot + 135_000
})
server.prependListener('request', req => {
  req.url = normalizeGatewayPath(req.url ?? '/')
})
server.prependListener('upgrade', req => { req.url = normalizeGatewayPath(req.url ?? '/') })
server.listen(8080, env.FAANGIN_GATEWAY_BIND_HOST)
let finish!: () => void
const lifetime = new Promise<void>(resolve => { finish = resolve })
if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(lifetime)
setTimeout(() => {
  server.close()
  void server.shutdown().finally(finish)
}, 110_000)
