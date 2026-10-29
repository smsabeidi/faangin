// Test doubles: a fake OpenAI (HTTP SSE + WebSocket) and a gateway wired to fakes and a MemoryStore.
import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { DEFAULT_FLAGS, type Entitlement, type Flags } from '../src/auth.js'
import { createGateway, type GatewayDeps } from '../src/gateway.js'
import { MemoryStore } from '../src/store.js'

export const PERIOD_START = Date.UTC(2026, 9, 1)
export const PERIOD_KEY = String(PERIOD_START)
export const NOW = Date.UTC(2026, 9, 28, 12)
export const TODAY = '2026-10-28'
export const OPENAI_KEY = 'test-openai-key'

export const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

export function parseSse(text: string): Array<{ event?: string; data: Record<string, unknown> }> {
  return text.split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n')
    const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim()
    const data = JSON.parse(lines.find(l => l.startsWith('data:'))!.slice(5)) as Record<string, unknown>
    return { event, data }
  })
}

export async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('until: timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

/** 2 s of pcm16 mono 24 kHz is 96 000 bytes, 128 000 base64 chars. */
export const audioBase64 = (seconds: number) => 'A'.repeat(Math.round((seconds * 48_000 * 4) / 3))

function readAll(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
}

export interface FakeOpenAI {
  httpBase: string
  wsBase: string
  requests: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown> }>
  /** usage put in the terminal event; null streams without usage */
  usage: Record<string, unknown> | null
  /** the terminal event: response.completed, response.incomplete or response.failed */
  finalEvent: string
  /** one-shot non-2xx answer */
  next: { status: number; body: unknown } | undefined
  /** keep streams open after response.created until release() */
  hold: boolean
  release(): void
  lastStream: string
  sessionUpdates: Array<Record<string, unknown>>
  appends: number[]
  commits: number
  sockets: Array<{ ws: WebSocket; headers: IncomingHttpHeaders }>
  emitError(): void
  close(): Promise<void>
}

export async function startFakeOpenAI(): Promise<FakeOpenAI> {
  const waiters: Array<() => void> = []
  const server = createServer(async (req, res) => {
    const body = JSON.parse(await readAll(req)) as Record<string, unknown>
    fake.requests.push({ headers: req.headers, body })
    if (fake.next) {
      const { status, body: answer } = fake.next
      fake.next = undefined
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const created = sse('response.created', { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } })
    res.write(created)
    if (fake.hold) await new Promise<void>(resolve => waiters.push(resolve))
    const response = {
      id: 'resp_1', object: 'response', status: fake.finalEvent.slice('response.'.length),
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
      ...(fake.usage ? { usage: fake.usage } : {})
    }
    const rest = sse('response.output_text.delta', { type: 'response.output_text.delta', delta: 'hi' }) + sse(fake.finalEvent, { type: fake.finalEvent, response })
    fake.lastStream = created + rest
    res.end(rest)
  })

  const wss = new WebSocketServer({ server, path: '/v1/realtime' })
  wss.on('connection', (ws, req) => {
    fake.sockets.push({ ws, headers: req.headers })
    let items = 0
    ws.on('message', data => {
      const event = JSON.parse(data.toString()) as Record<string, unknown>
      switch (event.type) {
        case 'session.update':
          fake.sessionUpdates.push(event)
          ws.send(JSON.stringify({ type: 'session.updated', session: event.session }))
          break
        case 'input_audio_buffer.append':
          fake.appends.push((event.audio as string).length)
          break
        case 'input_audio_buffer.commit': {
          fake.commits += 1
          const item_id = `item_${++items}`
          ws.send(JSON.stringify({ type: 'input_audio_buffer.committed', event_id: `event_${items}`, item_id, previous_item_id: null }))
          ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript: 'hello' }))
          break
        }
        case 'input_audio_buffer.clear':
          ws.send(JSON.stringify({ type: 'input_audio_buffer.cleared' }))
          break
      }
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  const fake: FakeOpenAI = {
    httpBase: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    requests: [],
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 500, total_tokens: 1500 },
    finalEvent: 'response.completed',
    next: undefined,
    hold: false,
    release: () => { for (const resolve of waiters.splice(0)) resolve() },
    lastStream: '',
    sessionUpdates: [],
    appends: [],
    commits: 0,
    sockets: [],
    emitError: () => fake.sockets.at(-1)!.ws.send(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'boom' } })),
    close: async () => {
      for (const { ws } of fake.sockets) ws.terminate()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
  return fake
}

export function proEntitlement(pro: Partial<NonNullable<Entitlement['pro']>> = {}, status: Entitlement['status'] = 'active'): Entitlement {
  return {
    plan: 'pro', status, updatedAt: NOW,
    pro: {
      subscriptionId: 'sub_1', priceLookupKey: 'faangin_pro_monthly', startedAt: PERIOD_START,
      currentPeriodStart: PERIOD_START, currentPeriodEnd: Date.UTC(2026, 10, 1), cancelAtPeriodEnd: false, rampUntil: NOW - 1, ...pro
    }
  }
}

export interface Gateway {
  base: string
  wsBase: string
  store: MemoryStore
  flags: Flags
  entitlements: Map<string, Entitlement>
  clock: { now: number }
  logs: Array<{ event: string; fields?: Record<string, unknown> }>
  /** What SIGTERM runs: closes live sockets and waits for their usage writes. */
  shutdown(): Promise<void>
  close(): Promise<void>
}

/** Tokens are `tok-<uid>`; entitlements and flags are plain objects the test mutates. */
export async function startGateway(fake: FakeOpenAI): Promise<Gateway> {
  const store = new MemoryStore()
  const flags: Flags = { ...DEFAULT_FLAGS, blockedUids: [] }
  const entitlements = new Map<string, Entitlement>()
  const clock = { now: NOW }
  const logs: Gateway['logs'] = []
  const deps: GatewayDeps = {
    verifyIdToken: async token => {
      if (!token.startsWith('tok-')) throw new Error('bad token')
      return { uid: token.slice(4) }
    },
    loadEntitlement: async uid => entitlements.get(uid) ?? { plan: 'none', status: 'active', updatedAt: 0 },
    loadFlags: async () => flags,
    store,
    openaiBase: fake.httpBase,
    openaiWsBase: fake.wsBase,
    openaiKey: OPENAI_KEY,
    now: () => clock.now,
    log: (event, fields) => logs.push({ event, fields })
  }
  const server = createGateway(deps)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}`, store, flags, entitlements, clock, logs,
    shutdown: () => server.shutdown(),
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}

export function post(gw: Gateway, token: string | undefined, body: unknown): Promise<Response> {
  return fetch(`${gw.base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })
}

export interface Client {
  ws: WebSocket
  messages: Array<Record<string, unknown>>
  send(event: unknown): void
  close(): Promise<void>
}

export async function openClient(gw: Gateway, token: string): Promise<Client> {
  const ws = new WebSocket(`${gw.wsBase}/v1/realtime?intent=transcription`, { headers: { authorization: `Bearer ${token}` } })
  const messages: Client['messages'] = []
  ws.on('message', data => messages.push(JSON.parse(data.toString()) as Record<string, unknown>))
  await once(ws, 'open')
  return {
    ws, messages,
    send: event => ws.send(JSON.stringify(event)),
    close: async () => {
      if (ws.readyState === WebSocket.CLOSED) return
      ws.close()
      await once(ws, 'close')
    }
  }
}
