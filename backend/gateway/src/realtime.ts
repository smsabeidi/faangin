/** GET /v1/realtime?intent=transcription: WebSocket proxy to OpenAI with audio metering and mute mode. */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { AuthOk, Entitlement } from './auth.js'
import { MAX_LIVE_SESSIONS, MODELS, SOCKET_IDLE_CLOSE_MS } from './config.js'
import { audioCostUsd, audioSecondsFromBase64, dayKey, isRamped, nextAudioState, overAudioLimit, periodKey, type AudioState } from './meter.js'
import type { Store, Usage } from './store.js'

export interface RealtimeDeps {
  store: Store
  openaiWsBase: string
  openaiKey: string
  now: () => number
  log: (event: string, fields?: Record<string, unknown>) => void
}

/** One live session has two audio channels, so two sockets. */
const MAX_SOCKETS_PER_UID = MAX_LIVE_SESSIONS * 2
const MAX_PROMPT_CHARS = 2500
/** Largest client message. The app sends at most 2 s of audio per append (128 000 base64 chars). */
const MAX_PAYLOAD_BYTES = 1024 * 1024
/** Bytes held for upstream while it is still connecting; anything beyond is dropped. */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024
const FLUSH_MS = 10_000
/** Sockets with less audio than this at the idle deadline are closed. */
const IDLE_AUDIO_SECONDS = 1
/** The only input format the metering math (PCM_BYTES_PER_SECOND) is right for, so it is forced. */
const PCM_FORMAT = { type: 'audio/pcm', rate: 24_000 }

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Client -> upstream allowlist. Returns the event to forward, or null to drop it. */
export function shapeClientEvent(raw: unknown): Json | null {
  if (!isRecord(raw)) return null
  const eventId = typeof raw.event_id === 'string' ? { event_id: raw.event_id } : {}
  switch (raw.type) {
    case 'session.update':
      return { type: 'session.update', ...eventId, session: shapeSession(raw.session) }
    case 'input_audio_buffer.append':
      return typeof raw.audio === 'string' ? { type: raw.type, ...eventId, audio: raw.audio } : null
    case 'input_audio_buffer.commit':
    case 'input_audio_buffer.clear':
      return { type: raw.type, ...eventId }
    default:
      return null
  }
}

function shapeSession(session: unknown): Json {
  const input = isRecord(session) && isRecord(session.audio) && isRecord(session.audio.input) ? session.audio.input : {}
  const given = isRecord(input.transcription) ? input.transcription : {}
  const transcription: Json = { model: MODELS.transcribe }
  if (given.languages !== undefined) transcription.languages = given.languages
  if (typeof given.prompt === 'string') transcription.prompt = given.prompt.slice(0, MAX_PROMPT_CHARS)
  if (given.delay !== undefined) transcription.delay = given.delay
  const shaped: Json = { transcription, format: PCM_FORMAT }
  if (input.turn_detection !== undefined) shaped.turn_detection = input.turn_detection
  return { type: 'transcription', audio: { input: shaped } }
}

/** A uid's open sockets and the one usage copy they all charge, so limits and the grace window see every socket. */
interface Live { sockets: Set<WebSocket>; period: string; usage: Usage }

export function createRealtime(deps: RealtimeDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES })
  const liveByUid = new Map<string, Live>()
  /** Store writes still in flight, so a shutdown can wait for them. */
  const inflightFlushes = new Set<Promise<void>>()

  /** Closes every live socket (each close handler flushes its usage) and waits for the writes. */
  async function shutdown(): Promise<void> {
    const closes: Promise<void>[] = []
    for (const live of liveByUid.values()) {
      for (const client of live.sockets) {
        closes.push(new Promise(resolve => {
          client.once('close', () => resolve())
          client.close(1001, 'server_shutdown')
        }))
      }
    }
    await Promise.all(closes)
    await Promise.allSettled([...inflightFlushes])
  }

  /** Called after authorize() succeeded on the upgrade request. */
  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, auth: AuthOk): Promise<void> {
    const { uid, entitlement, flags } = auth
    const period = periodKey(entitlement, deps.now())
    let fresh: Usage | undefined
    if (liveByUid.get(uid)?.period !== period) {
      try {
        fresh = await deps.store.read(uid, period)
      } catch (error) {
        deps.log('store_read_failed', { uid, error: String(error) })
      }
    }
    wss.handleUpgrade(req, socket, head, client => {
      // Before any close(): ws emits 'error' for a malformed frame even mid close handshake, and an unhandled one kills the process.
      client.on('error', error => deps.log('client_socket_error', { uid, error: String(error) }))
      if (flags.transcriptionOff) return client.close(1013, 'transcription_off')
      let live = liveByUid.get(uid)
      if (live && live.sockets.size >= MAX_SOCKETS_PER_UID) return client.close(1008, 'too_many_sockets')
      if (!live || live.period !== period) {
        if (!fresh) return client.close(1011, 'store_unavailable')
        live = { sockets: live?.sockets ?? new Set(), period, usage: fresh }
        liveByUid.set(uid, live)
      }
      const { sockets, usage } = live
      sockets.add(client)
      client.once('close', () => {
        sockets.delete(client)
        if (!sockets.size) liveByUid.delete(uid)
      })
      runSession(client, uid, entitlement, period, usage)
    })
  }

  function runSession(client: WebSocket, uid: string, entitlement: Entitlement, period: string, usage: Usage): void {
    const ramped = isRamped(entitlement, deps.now())
    const upstream = new WebSocket(`${deps.openaiWsBase}/v1/realtime?intent=transcription`, { headers: { authorization: `Bearer ${deps.openaiKey}` } })
    const queued: string[] = []
    let queuedBytes = 0
    let state: AudioState = { kind: 'open' }
    let sessionSeconds = 0 // charged on this socket
    let unflushed = { audioSeconds: 0, spendUsd: 0 }
    let mutedCommits = 0

    const toClient = (event: unknown) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)) }
    const toUpstream = (event: Json) => {
      const text = JSON.stringify(event)
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text)
      else if (upstream.readyState === WebSocket.CONNECTING && queuedBytes + text.length <= MAX_QUEUED_BYTES) {
        queued.push(text)
        queuedBytes += text.length
      }
    }

    const charge = (seconds: number) => {
      const day = dayKey(deps.now())
      const cost = audioCostUsd(seconds)
      sessionSeconds += seconds
      usage.audioSeconds += seconds
      usage.spendUsd += cost
      const today = (usage.days[day] ??= { audioSeconds: 0, spendUsd: 0 })
      today.audioSeconds += seconds
      today.spendUsd += cost
      unflushed.audioSeconds += seconds
      unflushed.spendUsd += cost
    }

    const flush = (): Promise<void> => {
      if (!unflushed.audioSeconds) return Promise.resolve()
      const delta = unflushed
      unflushed = { audioSeconds: 0, spendUsd: 0 }
      const pending = deps.store.increment(uid, period, dayKey(deps.now()), delta).catch(error => {
        deps.log('usage_flush_failed', { uid, error: String(error), ...delta })
      })
      inflightFlushes.add(pending)
      void pending.finally(() => inflightFlushes.delete(pending))
      return pending
    }

    const evaluate = () => {
      const now = deps.now()
      const next = nextAudioState(state, overAudioLimit(usage, dayKey(now), ramped), usage.graceUsedAt, now)
      if (next.kind === state.kind) return
      state = next
      if (next.kind === 'grace' && usage.graceUsedAt === undefined) {
        usage.graceUsedAt = now
        deps.store.increment(uid, period, dayKey(now), { graceUsedAt: now }).catch(error => deps.log('grace_write_failed', { uid, error: String(error) }))
      }
      deps.log('audio_state', { uid, state: next.kind, sessionSeconds })
    }

    upstream.on('open', () => { for (const text of queued.splice(0)) upstream.send(text) })
    upstream.on('message', data => {
      const text = data.toString()
      try {
        const event = JSON.parse(text) as Json
        if (event.type === 'error') return deps.log('upstream_event_error', { uid, error: event.error })
      } catch { /* forward as is */ }
      if (client.readyState === WebSocket.OPEN) client.send(text)
    })
    upstream.on('error', error => deps.log('upstream_socket_error', { uid, error: String(error) }))
    upstream.on('close', (code, reason) => {
      deps.log('upstream_closed', { uid, code, reason: reason.toString() })
      if (client.readyState === WebSocket.OPEN) client.close(1011, 'upstream_closed')
    })

    client.on('message', data => {
      let raw: unknown
      try { raw = JSON.parse(data.toString()) } catch { return }
      const event = shapeClientEvent(raw)
      if (!event) return
      const eventId = typeof event.event_id === 'string' ? event.event_id : undefined
      switch (event.type) {
        case 'input_audio_buffer.append':
          // Charged as it arrives: with server VAD upstream commits by itself and the client never sends commit.
          evaluate()
          if (state.kind === 'muted') return
          charge(audioSecondsFromBase64((event.audio as string).length))
          return toUpstream(event)
        case 'input_audio_buffer.commit':
          if (state.kind === 'muted') {
            mutedCommits += 1
            return toClient({ type: 'input_audio_buffer.committed', event_id: eventId ?? `event_faangin_${mutedCommits}`, item_id: `faangin_muted_${mutedCommits}`, previous_item_id: null })
          }
          return toUpstream(event)
        case 'input_audio_buffer.clear':
          if (state.kind === 'muted') return toClient({ type: 'input_audio_buffer.cleared', event_id: eventId ?? 'event_faangin_cleared' })
          return toUpstream(event)
        default:
          return toUpstream(event)
      }
    })

    const flushTimer = setInterval(() => void flush(), FLUSH_MS)
    const idleTimer = setTimeout(() => { if (sessionSeconds < IDLE_AUDIO_SECONDS) client.close(1000, 'idle') }, SOCKET_IDLE_CLOSE_MS)
    client.once('close', () => {
      clearInterval(flushTimer)
      clearTimeout(idleTimer)
      void flush()
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1000)
      else upstream.terminate()
    })

    evaluate()
  }

  return { upgrade, shutdown }
}
