/** Cloud Run entry point: Firebase Auth + Firestore behind createGateway. */
import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { DEFAULT_FLAGS, EMPTY_ENTITLEMENT, type Entitlement, type Flags } from './auth.js'
import { ENTITLEMENT_CACHE_MS, OPENAI_BASE, OPENAI_WS_BASE, PORT } from './config.js'
import { createGateway } from './gateway.js'
import { FirestoreStore } from './store.js'

const openaiKey = process.env.OPENAI_API_KEY
if (!openaiKey) {
  console.error('OPENAI_API_KEY is not set')
  process.exit(1)
}

if (!getApps().length) initializeApp()
const auth = getAuth()
const db = getFirestore()

const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...fields }))

/** A crash is at least logged before Cloud Run restarts the container. */
process.on('uncaughtException', error => {
  log('uncaught_exception', { error: String(error), stack: error.stack })
  process.exit(1)
})

/** Remembers each key's value for ttlMs. */
function cached<T>(ttlMs: number, load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const entries = new Map<string, { at: number; value: T }>()
  return async key => {
    const hit = entries.get(key)
    if (hit && Date.now() - hit.at < ttlMs) return hit.value
    const value = await load(key)
    entries.set(key, { at: Date.now(), value })
    return value
  }
}

const loadEntitlement = cached(ENTITLEMENT_CACHE_MS, async (uid): Promise<Entitlement> => {
  const snap = await db.doc(`entitlements/${uid}`).get()
  return snap.exists ? (snap.data() as Entitlement) : EMPTY_ENTITLEMENT
})

const loadFlags = cached(ENTITLEMENT_CACHE_MS, async (): Promise<Flags> => {
  const snap = await db.doc('flags/global').get()
  return { ...DEFAULT_FLAGS, ...(snap.data() ?? {}) }
})

const server = createGateway({
  verifyIdToken: token => auth.verifyIdToken(token),
  loadEntitlement,
  loadFlags: () => loadFlags('global'),
  store: new FirestoreStore(db),
  openaiBase: OPENAI_BASE,
  openaiWsBase: OPENAI_WS_BASE,
  openaiKey,
  now: () => Date.now(),
  log
})

server.listen(PORT, () => log('listening', { port: PORT }))

/** Cloud Run sends SIGTERM before stopping an instance: stop accepting, close live sockets, flush their usage, then exit. */
process.on('SIGTERM', () => {
  log('sigterm')
  server.close()
  void server.shutdown().finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 10_000).unref()
})
