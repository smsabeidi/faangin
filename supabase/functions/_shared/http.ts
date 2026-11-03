import { ServiceError } from '../../../backend/supabase/errors.ts'
const CODES: Record<string, { status: string; http: number }> = {
  'invalid-argument': { status: 'INVALID_ARGUMENT', http: 400 }, unauthenticated: { status: 'UNAUTHENTICATED', http: 401 },
  'not-found': { status: 'NOT_FOUND', http: 404 }, 'failed-precondition': { status: 'FAILED_PRECONDITION', http: 400 },
  'resource-exhausted': { status: 'RESOURCE_EXHAUSTED', http: 429 }, unavailable: { status: 'UNAVAILABLE', http: 503 }, internal: { status: 'INTERNAL', http: 500 }
}
export function cors(request: Request): Headers {
  const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  const origin = request.headers.get('origin')
  if (origin) {
    let allowed = false
    try { const url = new URL(origin); allowed = url.origin === origin && url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && Number(url.port) > 0 && Number(url.port) <= 65535 } catch { /* reject malformed origin */ }
    if (!allowed) throw new ServiceError('unauthenticated', 'This browser origin is not allowed')
    headers.set('access-control-allow-origin', origin); headers.set('vary', 'Origin')
    headers.set('access-control-allow-methods', 'POST, GET, OPTIONS'); headers.set('access-control-allow-headers', 'apikey, authorization, content-type')
  }
  return headers
}
export function json(body: unknown, status = 200, headers = new Headers()): Response { headers.set('content-type', 'application/json; charset=utf-8'); return new Response(JSON.stringify(body), { status, headers }) }
export function errorResponse(error: unknown, headers = new Headers()): Response {
  const safe = error instanceof ServiceError ? error : new ServiceError('internal', 'The request could not be completed. Please retry.')
  const mapped = CODES[safe.code] ?? CODES.internal
  return json({ error: { status: mapped.status, message: safe.message } }, mapped.http, headers)
}
/** Limit bytes while consuming the stream; Content-Length is optional and cannot enforce a memory bound. */
export async function boundedText(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get('content-length') || 0) > maxBytes) throw new ServiceError('invalid-argument', 'Request is too large')
  if (!request.body) return ''
  const reader = request.body.getReader(), decoder = new TextDecoder()
  let bytes = 0, text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return text + decoder.decode()
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) {
        // Do not wait for a malicious sender to finish or acknowledge cancellation.
        void reader.cancel().catch(() => {})
        throw new ServiceError('invalid-argument', 'Request is too large')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally { reader.releaseLock() }
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await boundedText(request, 65_536)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new ServiceError('invalid-argument', 'JSON object body required') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ServiceError('invalid-argument', 'JSON object body required')
  return parsed as Record<string, unknown>
}
