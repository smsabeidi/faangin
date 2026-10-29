/** Routes only. Every dependency is injected so tests run against fakes and an in-memory store. */
import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { authorize, type AuthDeps } from './auth.js'
import { createRealtime, type RealtimeDeps } from './realtime.js'
import { createResponses, sendJson, type ResponsesDeps } from './responses.js'

export type GatewayDeps = AuthDeps & ResponsesDeps & RealtimeDeps

const BODY_LIMIT_BYTES = 1_000_000

export type GatewayServer = Server & { /** Closes every live socket and waits for their usage to flush. */ shutdown(): Promise<void> }

export function createGateway(deps: GatewayDeps): GatewayServer {
  const responses = createResponses(deps)
  const realtime = createRealtime(deps)

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/responses') {
      const auth = await authorize(deps, req.headers.authorization)
      if (!auth.ok) return sendJson(res, auth.status, auth.body)
      const raw = await readBody(req)
      if (raw === null) {
        res.setHeader('connection', 'close')
        return sendJson(res, 413, { error: { code: 'body_too_large', message: `Body over ${BODY_LIMIT_BYTES} bytes` } })
      }
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        return sendJson(res, 400, { error: { code: 'invalid_json', message: 'Body must be JSON' } })
      }
      return responses.handle(auth, body, res)
    }
    sendJson(res, 404, { error: { code: 'not_found', message: `No route for ${req.method} ${url.pathname}` } })
  }

  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      deps.log('request_failed', { method: req.method, url: req.url, error: String(error) })
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal', message: 'Internal error' } })
      else res.end()
    })
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy())
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/v1/realtime' || url.searchParams.get('intent') !== 'transcription') {
      return rejectUpgrade(socket, 404, { error: { code: 'not_found', message: 'Only /v1/realtime?intent=transcription upgrades' } })
    }
    authorize(deps, req.headers.authorization)
      .then(auth => (auth.ok ? realtime.upgrade(req, socket, head, auth) : rejectUpgrade(socket, auth.status, auth.body)))
      .catch(error => {
        deps.log('upgrade_failed', { error: String(error) })
        rejectUpgrade(socket, 500, { error: { code: 'internal', message: 'Internal error' } })
      })
  })

  return Object.assign(server, { shutdown: () => realtime.shutdown() })
}

/** Resolves null once the body passes the limit; the rest of the upload is drained so the 413 can still be written. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        tooLarge = true
        chunks.length = 0
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

function rejectUpgrade(socket: Duplex, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`
  )
  socket.destroy()
}
