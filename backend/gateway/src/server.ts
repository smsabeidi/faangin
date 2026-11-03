/** Optional standalone Supabase gateway. Production deploys supabase-edge.ts as an Edge Function. */
import process from 'node:process'
import { createGateway } from './gateway.js'
import { createSupabaseBackend } from './supabase.js'
import { OPENAI_BASE, OPENAI_WS_BASE, PORT } from './config.js'
import { resolveSupabaseServerKey } from './supabase-server-key.js'
const env = process.env
const serviceKey = resolveSupabaseServerKey({ get: name => env[name] }, 'node')
const publishableKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY
if (!env.SUPABASE_URL || !serviceKey || !publishableKey) throw new Error('Supabase gateway configuration is incomplete')
const backend = createSupabaseBackend({ url: env.SUPABASE_URL, serviceKey, publishableKey })
const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...fields }))
const server = createGateway({ ...backend, openaiBase: OPENAI_BASE, openaiWsBase: OPENAI_WS_BASE,
  openaiKey: env.OPENAI_API_KEY ?? '', providerReady: !!env.OPENAI_API_KEY, now: () => Date.now(), log })
server.listen(PORT, () => log('listening', { port: PORT }))
process.on('SIGTERM', () => {
  server.close()
  void server.shutdown().finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 10_000).unref()
})
