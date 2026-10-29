/** POST /v1/responses: allowlisted body, metered, upstream SSE piped through verbatim. */
import type { ServerResponse } from 'node:http'
import type { AuthOk } from './auth.js'
import { CAPS, MODELS, type Mode } from './config.js'
import { capEstimateUsd, dayKey, decideAnswer, estimateCostUsd, isRamped, periodKey, type TokenUsage } from './meter.js'
import type { Store } from './store.js'

export interface ResponsesDeps {
  store: Store
  openaiBase: string
  openaiKey: string
  now: () => number
  log: (event: string, fields?: Record<string, unknown>) => void
}

/** The only client fields that reach OpenAI. */
const ALLOWED_FIELDS = ['input', 'instructions', 'max_output_tokens', 'reasoning', 'text', 'truncation', 'prompt_cache_key'] as const

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function pickMode(model: unknown): Mode | null {
  return model === 'fast' || model === 'smart' || model === 'handsfree' ? model : null
}

export function buildUpstreamBody(body: Record<string, unknown>, mode: Mode): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of ALLOWED_FIELDS) if (body[field] !== undefined) out[field] = body[field]
  const maxOutput = CAPS[mode].output
  out.max_output_tokens = typeof body.max_output_tokens === 'number' ? Math.min(body.max_output_tokens, maxOutput) : maxOutput
  out.model = MODELS[mode]
  out.stream = true
  out.store = false
  return out
}

/** What a skipped hands-free turn streams: a completed response with no output and zero usage. */
export function syntheticCompletedSse(): string {
  const usage = { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 }
  const event = { type: 'response.completed', sequence_number: 0, response: { id: 'resp_faangin_skipped', object: 'response', status: 'completed', output: [], usage } }
  return `event: response.completed\ndata: ${JSON.stringify(event)}\n\n`
}

/** The terminal events; each carries response.usage (hitting max_output_tokens ends in incomplete, an error in failed). */
const USAGE_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed'])

/** Finds usage in the terminal event's data line of a stream fed chunk by chunk. */
export function makeUsageScanner() {
  let rest = ''
  let usage: TokenUsage | undefined
  const scan = (line: string) => {
    if (usage || !line.startsWith('data:') || !line.includes('"usage"')) return
    try {
      const event = JSON.parse(line.slice(5)) as { type?: string; response?: { usage?: TokenUsage | null } }
      if (USAGE_EVENTS.has(event.type ?? '') && event.response?.usage) usage = event.response.usage
    } catch { /* not JSON, not ours */ }
  }
  return {
    push(text: string) {
      const lines = (rest + text).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) scan(line)
    },
    end(text = ''): TokenUsage | undefined {
      this.push(text + '\n')
      return usage
    }
  }
}

export function createResponses(deps: ResponsesDeps) {
  const inFlight = new Map<string, number>()

  async function handle(auth: AuthOk, raw: unknown, res: ServerResponse): Promise<void> {
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
    const requested = body ? pickMode(body.model) : null
    if (!body || !requested) return sendJson(res, 400, { error: { code: 'invalid_mode', message: 'model must be fast, smart or handsfree' } })

    const { uid, entitlement, flags } = auth
    const now = deps.now()
    const period = periodKey(entitlement, now)
    const usage = await deps.store.read(uid, period)
    const decision = decideAnswer({ mode: requested, usage, day: dayKey(now), ramped: isRamped(entitlement, now), inFlight: inFlight.get(uid) ?? 0, flags })
    switch (decision.kind) {
      case 'concurrency': return sendJson(res, 429, { error: { code: 'concurrency', message: 'Too many answers in flight' } })
      case 'exhausted': return sendJson(res, 429, { error: { code: 'allowance_exhausted', allowance: decision.allowance, message: 'Allowance exhausted for this period' } })
      case 'backstop': return sendJson(res, 429, { error: { code: 'backstop', message: 'Spend backstop reached' } })
      case 'skip':
        res.writeHead(200, SSE_HEADERS)
        res.end(syntheticCompletedSse())
        return
    }

    const { mode, downgraded } = decision
    inFlight.set(uid, (inFlight.get(uid) ?? 0) + 1)
    try {
      await deps.store.increment(uid, period, dayKey(now), { [mode]: 1 })
      await forward(uid, period, mode, downgraded, buildUpstreamBody(body, mode), res)
    } finally {
      inFlight.set(uid, (inFlight.get(uid) ?? 1) - 1)
    }
  }

  async function forward(uid: string, period: string, mode: Mode, downgraded: boolean, upstreamBody: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableEnded) abort.abort() })

    let upstream: Response
    try {
      upstream = await fetch(`${deps.openaiBase}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${deps.openaiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(upstreamBody),
        signal: abort.signal
      })
    } catch (error) {
      if (abort.signal.aborted) return
      deps.log('upstream_unreachable', { uid, mode, error: String(error) })
      return sendJson(res, 502, { error: { code: 'upstream_unavailable', message: 'Could not reach the model provider' } })
    }

    if (!upstream.ok) {
      const text = await upstream.text()
      deps.log('upstream_error', { uid, mode, status: upstream.status })
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      res.end(text)
      return
    }

    res.writeHead(200, downgraded ? { ...SSE_HEADERS, 'x-faangin-mode': mode } : SSE_HEADERS)
    const scanner = makeUsageScanner()
    const decoder = new TextDecoder()
    let tokenUsage: TokenUsage | undefined
    try {
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          scanner.push(decoder.decode(chunk, { stream: true }))
          res.write(chunk)
        }
      }
      tokenUsage = scanner.end(decoder.decode())
    } catch (error) {
      if (!abort.signal.aborted) deps.log('upstream_stream_failed', { uid, mode, error: String(error) })
    } finally {
      res.end()
    }

    const cost = tokenUsage ? estimateCostUsd(mode, tokenUsage) : capEstimateUsd(mode)
    await deps.store.increment(uid, period, dayKey(deps.now()), { spendUsd: cost })
  }

  return { handle }
}
