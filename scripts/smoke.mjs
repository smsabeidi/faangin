import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import WebSocket from 'ws'
import { writeDocumentFixtures } from './fixtures.mjs'
import { runDesktopWorkflow, verifyDesktopPersistence } from './smoke-workflow.mjs'
import { startSmokeProvider } from './smoke-provider.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const configuredApp = process.env.FAANGIN_APP_PATH
const nativeAudio = process.env.FAANGIN_SMOKE_NATIVE_AUDIO === '1'
if (nativeAudio && !configuredApp) throw new Error('FAANGIN_SMOKE_NATIVE_AUDIO requires FAANGIN_APP_PATH for the packaged Faangin permission identity.')
const fixture = await mkdtemp(join(tmpdir(), 'faangin-smoke-'))
await writeDocumentFixtures(fixture)
const executable = configuredApp
  ? (configuredApp.endsWith('.app') ? join(configuredApp, 'Contents', 'MacOS', 'Faangin') : configuredApp)
  : require('electron')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const redact = value => String(value).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
function launch(markerName) {
  const marker = join(fixture, markerName)
  const env = { ...process.env, FAANGIN_SMOKE: '1', FAANGIN_USER_DATA_DIR: fixture, FAANGIN_SMOKE_READY: marker, FAANGIN_SMOKE_DOCUMENT_FIXTURES_DIR: fixture, FAANGIN_SMOKE_LIVE_FIXTURE: '1', FAANGIN_SMOKE_ACCESS_FIXTURE: 'ready' }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'OPENAI_API_KEY', 'ELECTRON_RENDERER_URL', 'FAANGIN_QA_VISIBLE']) delete env[name]
  const debugFlags = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']
  const child = spawn(executable, configuredApp ? debugFlags : [root, ...debugFlags], { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const running = { child, marker, logs: '', exitCode: undefined, spawnError: undefined }
  child.stdout.on('data', data => { running.logs = (running.logs + data.toString()).slice(-8000) })
  child.stderr.on('data', data => { running.logs = (running.logs + data.toString()).slice(-8000) })
  child.on('exit', code => { running.exitCode = code ?? -1 })
  child.on('error', error => { running.spawnError = error })
  return running
}
async function ready(running) {
  let report
  const deadline = Date.now() + 35000
  while (Date.now() < deadline && running.exitCode === undefined && !running.spawnError) {
    try { report = JSON.parse(await readFile(running.marker, 'utf8')); break } catch { await delay(250) }
  }
  if (running.spawnError) throw running.spawnError
  if (!report) throw new Error(`Desktop startup did not become ready (exit: ${running.exitCode ?? 'running'}).\n${redact(running.logs.slice(-1600))}`)
  if (report.error) throw new Error(`Isolated desktop startup failed: ${redact(report.error)}`)
  if (!report.rendererReady || !report.sqliteReady || report.keyConfigured !== false || !report.windowCount) {
    throw new Error(`Desktop startup checks failed: ${JSON.stringify(report)}`)
  }
  if (report.security?.sandbox !== true || report.security?.contextIsolation !== true || report.security?.nodeIntegration !== false) {
    throw new Error('Desktop security configuration failed.')
  }
  if (report.documentImports?.pdf !== true || report.documentImports?.docx !== true) throw new Error(`Isolated document import failed: ${JSON.stringify(report)}`)
  if (!report.workflow?.interviewReady || !report.workflow?.transparencyReady || !report.workflow?.resetReady || !report.workflow?.restoreReady) throw new Error(`Isolated interview workflow failed: ${JSON.stringify(report)}`)
  return report
}
async function stop(running) {
  if (!running?.child.pid || running.exitCode !== undefined) return
  const child = running.child
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)])
  if (running.exitCode === undefined) {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1000)])
  }
}

async function debuggerURL(running, windowKind = 'workspace') {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline && running.exitCode === undefined) {
    let port = running.logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]
    if (!port) { try { port = (await readFile(join(fixture, 'DevToolsActivePort'), 'utf8')).split('\n')[0] } catch {} }
    if (/^\d+$/.test(port ?? '') && Number(port) > 0 && Number(port) <= 65535) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
        const targets = await response.json()
        const target = targets.find(target => {
          if (target.type !== 'page') return false
          try { const url = new URL(target.url); return url.protocol === 'file:' && url.pathname.endsWith('/index.html') && url.searchParams.get('window') === windowKind } catch { return false }
        })
        if (target?.webSocketDebuggerUrl) {
          const url = new URL(target.webSocketDebuggerUrl)
          if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== port || !url.pathname.startsWith('/devtools/page/')) throw new Error('The smoke debugger did not use an isolated loopback target.')
          return url.href
        }
      } catch (error) { if (String(error).includes('isolated loopback target')) throw error }
    }
    await delay(200)
  }
  throw new Error('The isolated desktop debugger did not become ready.')
}

async function connectDebugger(url) {
  const socket = new WebSocket(url, { handshakeTimeout: 2000, maxPayload: 4 * 1024 * 1024 })
  const pending = new Map()
  const failPending = () => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('The isolated desktop debugger disconnected.')) } pending.clear() }
  socket.on('error', failPending); socket.on('close', failPending)
  socket.on('message', bytes => {
    let message
    try { message = JSON.parse(bytes.toString()) } catch { return }
    const job = pending.get(message.id)
    if (!job) return
    pending.delete(message.id); clearTimeout(job.timer)
    if (message.error) job.reject(new Error(`Desktop debugger request failed: ${redact(message.error.message)}`))
    else job.resolve(message.result)
  })
  await new Promise((resolve, reject) => {
    const opened = () => { socket.removeListener('error', failed); resolve() }
    const failed = () => { socket.removeListener('open', opened); reject(new Error('The isolated desktop debugger could not connect.')) }
    socket.once('open', opened); socket.once('error', failed)
  })
  let sequence = 0
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The isolated desktop workflow timed out.')) }, 35000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }), error => {
      if (!error) return
      const job = pending.get(id); if (!job) return
      pending.delete(id); clearTimeout(job.timer); job.reject(new Error('The isolated desktop debugger could not send its request.'))
    })
  })
  return {
    async evaluate(expression) {
      const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 30000 })
      if (response.exceptionDetails) {
        const message = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
        throw new Error(`Isolated desktop workflow failed: ${redact(message).split('\n')[0].slice(0, 1200)}`)
      }
      return response.result?.value
    },
    async screenshot(path) {
      const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      if (typeof result.data !== 'string') throw new Error('The isolated desktop did not return a preview.')
      await writeFile(path, Buffer.from(result.data, 'base64'))
    },
    async viewport(width, height) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }) },
    close() { failPending(); socket.close() }
  }
}
function verified(report, groups) {
  for (const group of groups) if (!report?.[group] || Object.values(report[group]).some(value => value !== true)) throw new Error(`Isolated desktop ${group} workflow did not pass.`)
}

let running, debuggerClient, overlayDebugger, provider
try {
  provider = await startSmokeProvider()
  running = launch('ready.json')
  const startup = await ready(running)
  debuggerClient = await connectDebugger(await debuggerURL(running))
  const isolation = await debuggerClient.evaluate('({ sandbox: window.faanginSmoke?.sandbox, contextIsolation: window.faanginSmoke?.contextIsolation, preload: typeof window.faangin?.getState === "function", nodeIntegration: typeof window.require !== "undefined" })')
  if (isolation?.sandbox !== true || isolation.contextIsolation !== true || isolation.preload !== true || isolation.nodeIntegration !== false) throw new Error('The workflow debugger did not reach the sandboxed smoke workspace.')
  await debuggerClient.evaluate(`(async () => { const until = Date.now() + 3000; while (!document.querySelector('[data-onboarding-skip], .sidebar') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20)); document.querySelector('[data-onboarding-skip]')?.click(); })()`)
  const workflow = await debuggerClient.evaluate(`(${runDesktopWorkflow.toString()})(window.faangin, ${JSON.stringify(provider.endpoint)}, ${JSON.stringify({ nativeAudio })})`)
  verified(workflow, ['capture', 'inference', 'presets', 'context', 'history'])
  if (provider.requests.length !== 21 || provider.requests[0].memory !== true || provider.requests.slice(1).some(request => request.memory) || !provider.requests.find(request => request.route === '/slow')?.cancelled || !provider.requests.find(request => request.route === '/draft')?.draftSources || !provider.requests.find(request => request.route === '/reply')?.replySources || !provider.requests.find(request => request.route === '/automatic')?.automaticSources || provider.requests.filter(request => request.automatic).length !== 9 || !provider.requests.find(request => request.route === '/automatic-failure' && request.automatic) || provider.requests.filter(request => request.interviewSolution).length !== 1 || provider.requests.filter(request => request.interviewContinuity).length !== 2 || !provider.requests.find(request => request.spokenContinuity) || !provider.requests.find(request => request.quietContext) || !provider.requests.find(request => request.freshCandidateContext) || !provider.requests.find(request => request.route === '/automatic-late-context' && !request.freshCandidateContext && request.cancelled) || provider.requests.filter(request => request.interruptionContext).length !== 2 || provider.requests.filter(request => request.interruptionStage?.endsWith('old') && request.cancelled).length !== 2) throw new Error('Local fixture transport, source consent, drafting, spoken reply, automatic reply, failure pause, or cancellation did not match the admitted requests.')
  await debuggerClient.evaluate(`window.faangin.updateSettings(${JSON.stringify({chatProvider:'compatible',compatibleChatEndpoint:provider.endpoint,compatibleChatModel:'fixture-fast',compatibleChatSmartModel:'fixture-smart',microphone:false,systemAudio:true,liveSuggestionSource:'system'})})`)
  await debuggerClient.evaluate(`window.faangin.selectSession(${JSON.stringify(workflow.ids.interviewFlow)})`)
  for (const [width, height] of [[1280, 808], [1000, 650], [900, 550]]) {
    await debuggerClient.viewport(width, height)
    await delay(80)
    const geometry = await debuggerClient.evaluate(`(() => { const pane = document.querySelector('.workspace-main'), feed = document.querySelector('.answer-feed'); return { width: innerWidth, height: innerHeight, pageWidth: document.body.scrollWidth, answerHeight: feed?.clientHeight, paneHeight: pane?.clientHeight, paneContent: pane?.scrollHeight }; })()`)
    if (geometry.pageWidth > width + 1 || geometry.answerHeight < (height > 650 ? 230 : 200) || (height > 650 && geometry.paneContent > geometry.paneHeight + 1)) throw new Error(`Interview layout did not fit the checked viewport: ${JSON.stringify(geometry)}`)
  }
  await debuggerClient.viewport(1280, 808)
  if (process.env.FAANGIN_SMOKE_SCREENSHOT) {
    await delay(250)
    await debuggerClient.evaluate(`(() => { const feed = document.querySelector('.answer-feed'); const card = feed?.querySelector('.answer-card:last-child'); if (feed && card) feed.scrollTop += card.getBoundingClientRect().top - feed.getBoundingClientRect().top; })()`)
    await debuggerClient.screenshot(process.env.FAANGIN_SMOKE_SCREENSHOT)
  }
  await debuggerClient.evaluate('window.faangin.openWindow("overlay")')
  overlayDebugger = await connectDebugger(await debuggerURL(running, 'overlay'))
  const overlayChecks = await overlayDebugger.evaluate(`(async () => {
    const until=Date.now()+2000; while(!document.querySelector('.overlay-topbar .overlay-capture-button') && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,15));
    const state=await window.faangin.getState(), menu=document.querySelector('.overlay-more'); const initiallyClosed=!!menu&&!menu.open;
    menu?.querySelector('summary')?.click(); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const labels=[...document.querySelectorAll('.overlay-more-panel button')].map(button=>button.textContent.trim());
    return {kind:state.windowKind,capture:!!document.querySelector('.overlay-topbar button[aria-label="Capture & solve"]'),listen:labels.some(label=>/Start hands-free|Enable hands-free|Listening|Stop listening/.test(label)),followup:labels.some(label=>/Answer follow-up|Answer latest/.test(label)),settings:labels.includes('Audio, shortcuts & settings'),consent:document.querySelector('.overlay-more-panel .hands-free-consent')?.textContent.includes('Transcribes microphone + computer audio with OpenAI.'),automatic:document.querySelector('.overlay-more-panel')?.textContent.includes('Automatic help'),uncluttered:initiallyClosed&&!document.querySelector('.overlay-actions, .interview-flow.compact, .overlay-footer')};
  })()`)
  if(overlayChecks.kind!=='overlay'||Object.entries(overlayChecks).some(([key,value])=>key!=='kind'&&value!==true))throw new Error(`Compact overlay controls failed: ${JSON.stringify(overlayChecks)}`)
  overlayDebugger.close(); overlayDebugger = undefined
  debuggerClient.close(); debuggerClient = undefined
  await stop(running); running = undefined
  running = launch('ready-reopen.json')
  await ready(running)
  debuggerClient = await connectDebugger(await debuggerURL(running))
  const persistence = await debuggerClient.evaluate(`(${verifyDesktopPersistence.toString()})(window.faangin, ${JSON.stringify(workflow.ids)})`)
  if (!persistence || Object.values(persistence).some(value => value !== true)) throw new Error('Isolated restart persistence checks did not pass.')
  console.log(`Faangin ${startup.version}: 21 isolated fixture requests passed. ${nativeAudio ? 'Performed bounded native system audio capture; no retained audio or live inference. ' + JSON.stringify(workflow.nativeAudio) : 'Native Electron display permission reached the owned capture handler without opening an OS stream. No live inference or recording was performed.'} Sandboxed startup, document imports, interview brief, selected-image Solve, BFS/DFS manual and automatic follow-up continuity with history off, streaming, Fast/Smart routing, selected memory, cancellation, safe quota errors, spoken Reply, automatic source/partial/disable/stop/failure guards, and saved answers verified across restart.`)
} finally {
  overlayDebugger?.close()
  debuggerClient?.close()
  await stop(running)
  await provider?.close()
  await rm(fixture, { recursive: true, force: true })
}
