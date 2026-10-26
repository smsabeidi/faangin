/** Required-access regression with mocked OS permissions and real production IPC/UI guards. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const configuredApp = process.env.FAANGIN_APP_PATH
const executable = configuredApp
  ? configuredApp.endsWith('.app') ? join(configuredApp, 'Contents', 'MacOS', 'Faangin') : configuredApp
  : require('electron')
const fixture = await mkdtemp(join(tmpdir(), 'faangin-required-access-qa-'))
const output = process.env.FAANGIN_ACCESS_QA_OUTPUT || join(root, 'output', 'qa', 'access-setup')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const redact = value => String(value).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
const report = {
  application: configuredApp || root,
  scope: 'Disposable profile and explicitly mocked native permission results; real production IPC guards, renderer UI, automatic status checks, setup persistence, and a synthetic capture lifecycle. No host permission changes, native prompts, desktop capture, audio recording, provider credentials, or remote requests.',
  hostTccChangesTested: false, realSystemAudioProbeExecuted: false,
  checks: {}, layouts: [], guardResults: [], screenshots: [], rendererExceptions: [],
}
await mkdir(output, { recursive: true })

function launch(markerName, retainedOsGrants = false) {
  const marker = join(fixture, markerName), env = { ...process.env }
  for (const name of Object.keys(env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(name) || name.startsWith('FAANGIN_SMOKE')) delete env[name]
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'FAANGIN_QA_VISIBLE']) delete env[name]
  Object.assign(env, { FAANGIN_SMOKE: '1', FAANGIN_USER_DATA_DIR: fixture, FAANGIN_SMOKE_READY: marker, FAANGIN_SMOKE_LIVE_FIXTURE: '1', FAANGIN_SMOKE_ACCESS_FIXTURE: 'required' })
  if (retainedOsGrants) env.FAANGIN_SMOKE_ACCESS_OS_GRANTED = '1'
  const flags = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']
  const child = spawn(executable, configuredApp ? flags : [root, ...flags], { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const running = { child, marker, logs: '', exitCode: undefined, spawnError: undefined }
  child.stdout.on('data', bytes => { running.logs = (running.logs + bytes.toString()).slice(-10000) })
  child.stderr.on('data', bytes => { running.logs = (running.logs + bytes.toString()).slice(-10000) })
  child.on('exit', code => { running.exitCode = code ?? -1 }); child.on('error', error => { running.spawnError = error })
  return running
}

async function until(label, fn, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(40) }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function ready(running) {
  return until('isolated access fixture startup', async () => {
    if (running.spawnError) throw running.spawnError
    if (running.exitCode !== undefined) throw new Error(`App exited (${running.exitCode}): ${redact(running.logs.slice(-1600))}`)
    let value
    try { value = JSON.parse(await readFile(running.marker, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
    if (value.error) throw new Error(redact(value.error))
    assert.equal(value.keyConfigured, false)
    assert.equal(value.security?.sandbox, true); assert.equal(value.security?.contextIsolation, true); assert.equal(value.security?.nodeIntegration, false)
    return value
  }, 35000)
}

async function stop(running) {
  if (!running?.child.pid || running.exitCode !== undefined) return
  const signal = value => { try { process.kill(process.platform === 'win32' ? running.child.pid : -running.child.pid, value) } catch { running.child.kill(value) } }
  signal('SIGTERM')
  await Promise.race([new Promise(resolve => running.child.once('exit', resolve)), delay(2500)])
  if (running.exitCode === undefined) { signal('SIGKILL'); await Promise.race([new Promise(resolve => running.child.once('exit', resolve)), delay(1000)]) }
}

async function connect(running) {
  const url = await until('owned workspace debugger', async () => {
    let port = running.logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]
    if (!port) { try { port = (await readFile(join(fixture, 'DevToolsActivePort'), 'utf8')).split('\n')[0] } catch {} }
    if (!/^\d+$/.test(port || '')) return false
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
      const target = (await response.json()).find(value => {
        if (value.type !== 'page') return false
        try { const page = new URL(value.url); return page.protocol === 'file:' && page.pathname.endsWith('/index.html') && page.searchParams.get('window') === 'workspace' } catch { return false }
      })
      if (!target?.webSocketDebuggerUrl) return false
      const result = new URL(target.webSocketDebuggerUrl)
      assert.equal(result.protocol, 'ws:'); assert.equal(result.hostname, '127.0.0.1'); assert.equal(result.port, port)
      assert.ok(result.pathname.startsWith('/devtools/page/')); return result.href
    } catch (error) { if (error instanceof assert.AssertionError) throw error; return false }
  })
  const socket = new WebSocket(url, { handshakeTimeout: 3000, maxPayload: 16 * 1024 * 1024 }), pending = new Map()
  const fail = () => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('Access QA debugger disconnected.')) } pending.clear() }
  socket.on('error', fail); socket.on('close', fail)
  socket.on('message', bytes => {
    const value = JSON.parse(bytes.toString())
    if (value.method === 'Runtime.exceptionThrown') report.rendererExceptions.push(redact(value.params?.exceptionDetails?.exception?.description || value.params?.exceptionDetails?.text || 'Unknown renderer exception'))
    const job = pending.get(value.id)
    if (!job) return
    pending.delete(value.id); clearTimeout(job.timer)
    value.error ? job.reject(new Error(value.error.message)) : job.resolve(value.result)
  })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  let sequence = 0
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)) }, 15000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable'); await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return {
    send,
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(redact(result.exceptionDetails.exception?.description || result.exceptionDetails.text))
      return result.result?.value
    },
    async screenshot(name) { const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(output, name), Buffer.from(result.data, 'base64')); report.screenshots.push(name) },
    async key(key, shift = false) {
      const code = { Tab: 9, Enter: 13, Escape: 27 }[key]; assert.ok(code)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0, ...(key === 'Enter' ? { text: '\r' } : {}) })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 })
    },
    close() { fail(); socket.close() },
  }
}

const state = client => client.evaluate('window.faangin.getState()')
const access = async client => (await state(client)).accessSetup
const telemetry = client => client.evaluate('window.faanginSmoke.liveFixture({type:"access-telemetry"})')
const mock = (client, patch) => client.evaluate(`window.faanginSmoke.liveFixture(${JSON.stringify({ type: 'access-fixture', ...patch })})`)
async function primary(client) {
  await until('enabled access action', () => client.evaluate('!!document.querySelector(".access-setup-primary:not(:disabled)")'))
  await client.evaluate('document.querySelector(".access-setup-primary").click()')
}
async function gate(client) {
  await until('required access screen', () => client.evaluate('!!document.querySelector(".access-setup")'))
  assert.equal(await client.evaluate('!!document.querySelector(".sidebar,.onboarding,.overlay-topbar")'), false, 'Access must precede both the tour and usable workspace')
}
function noWork(value) {
  for (const key of ['captureStarts', 'generationStarts', 'screenCaptures', 'cloudRequests']) assert.equal(value[key], 0, `${key} must stay zero before access is completed`)
  assert.equal(value.capture.active, false)
  assert.equal(value.activeProbeTracks, 0)
  assert.equal(value.allTracksStopped, true)
}

async function checkLayout(client, name) {
  for (const [width, height] of [[1000, 650], [900, 550]]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await client.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const geometry = await client.evaluate(`(() => {
      const dialog=document.querySelector('.access-setup'),main=dialog.querySelector('.access-setup-main'),footer=dialog.querySelector('.access-setup-footer'),help=dialog.querySelector('.access-setup-help');
      const bounds=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
      return {width:innerWidth,height:innerHeight,pageWidth:document.body.scrollWidth,dialog:bounds(dialog),dialogWidth:dialog.clientWidth,contentWidth:dialog.scrollWidth,main:bounds(main),footer:bounds(footer),help:help&&bounds(help),helpButtons:[...help?.querySelectorAll('button')||[]].map(e=>({label:e.textContent.trim(),...bounds(e)})),buttons:[...footer.querySelectorAll('button')].map(e=>({label:e.textContent.trim(),...bounds(e)})),rows:[...dialog.querySelectorAll('.access-setup-row')].map(e=>({kind:e.dataset.permission,...bounds(e)}))};
    })()`)
    assert.ok(geometry.pageWidth <= width + 1 && geometry.contentWidth <= geometry.dialogWidth + 1)
    assert.ok(geometry.dialog.left >= -1 && geometry.dialog.right <= width + 1 && geometry.dialog.top >= -1 && geometry.dialog.bottom <= height + 1)
    assert.ok(geometry.main.height >= 100)
    assert.equal(geometry.rows.length, 3)
    if (name === 'denied-access') {
      assert.ok(geometry.help && geometry.helpButtons.length >= 2, 'Denied audio needs visible Settings and Retry guidance')
      assert.ok(geometry.help.top >= geometry.main.top - 1 && geometry.help.bottom <= geometry.main.bottom + 1, 'Denied-permission instructions must fit above the fixed footer')
      for (const button of geometry.helpButtons) assert.ok(button.top >= geometry.main.top - 1 && button.bottom <= geometry.main.bottom + 1, `${button.label} must remain visible without scrolling`)
    }
    for (const button of geometry.buttons) assert.ok(button.top >= -1 && button.bottom <= height + 1 && button.left >= -1 && button.right <= width + 1 && button.height >= 32, 'Primary access action must remain readable and reachable')
    report.layouts.push({ phase: name, ...geometry })
    await client.screenshot(`${name}-${width}x${height}.png`)
  }
}

async function assertBlocked(client, label, expression) {
  const result = await client.evaluate(`(async()=>{try{await (${expression});return {blocked:false}}catch(error){return {blocked:true,message:error.message}}})()`)
  report.guardResults.push({ label, ...result })
  assert.equal(result.blocked, true, `${label} must reject before its actual work starts`)
  assert.match(result.message, /access|permission|setup/i, `${label} must explain how to recover`)
}

let running, client
try {
  if (configuredApp?.endsWith('.app')) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(configuredApp, 'Contents', 'Resources', 'app.asar'))) hash.update(chunk)
    report.appAsarSha256 = hash.digest('hex')
  }
  running = launch('ready-first.json')
  report.version = (await ready(running)).version
  client = await connect(running)
  await gate(client)
  const initial = await access(client)
  assert.equal(initial.required, true); assert.equal(initial.completed, false); assert.equal(initial.ready, false)
  assert.equal(initial.permissions.systemAudio, 'not-requested')
  noWork(await telemetry(client))
  report.checks.freshInstallIsGatedBeforeWorkspace = true
  await checkLayout(client, 'first-access')
  await client.key('Escape')
  await gate(client)
  const controls = await client.evaluate(`(() => {const d=document.querySelector('.access-setup');const controls=[...d.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]')].filter(e=>e.getClientRects().length);window.__accessQaControls=controls;controls.at(-1).focus();return controls.map(e=>e.getAttribute('aria-label')||e.textContent.trim());})()`)
  assert.equal(controls.some(label => /skip|explore|finish later|close setup/i.test(label)), false)
  await client.key('Tab')
  assert.equal(await client.evaluate('document.activeElement===window.__accessQaControls[0]'), true)
  await client.key('Tab', true)
  assert.equal(await client.evaluate('document.activeElement===window.__accessQaControls.at(-1)'), true)
  await client.evaluate('delete window.__accessQaControls')
  assert.equal((await access(client)).completed, false)
  report.checks.noSkipEscapeOrKeyboardBypass = true

  const id = (await state(client)).currentSession.id, sessionId = JSON.stringify(id)
  const blocked = [
    ['Generate', `window.faangin.generate({sessionId:${sessionId},action:'assist',prompt:'Controlled access regression'})`],
    ['Capture screenshot', `window.faangin.captureScreen(${sessionId})`],
    ['Capture and solve', `window.faangin.captureAndSolve(${sessionId})`],
    ['Preview screen region', `window.faangin.previewScreenshotRegion(${sessionId})`],
    ['List capture sources', 'window.faangin.listCaptureSources()'],
    ['Start listening', `window.faangin.startCapture(${sessionId})`],
    ['Resume listening', `window.faangin.resumeCapture(${sessionId})`],
    ['Open overlay', `window.faangin.openWindow('overlay')`],
    ['Resize overlay', 'window.faangin.resizeOverlay({width:480,height:560})'],
    ['Reset overlay', 'window.faangin.resetOverlayLayout()'],
    ['Chat provider test', 'window.faangin.testChatConnection()'],
    ['Transcription provider test', 'window.faangin.testConnection()'],
    ['Premature setup completion', 'window.faangin.completeAccessSetup()'],
  ]
  for (const [label, expression] of blocked) await assertBlocked(client, label, expression)
  for (const action of ['capture-solve', 'screenshot', 'toggle-capture', 'assist', 'solve', 'reply', 'hide', 'toggle-interaction', 'move-right']) {
    await client.evaluate(`window.faanginSmoke.liveFixture(${JSON.stringify({ type: 'access-shortcut', action })})`)
  }
  const guards = await telemetry(client)
  noWork(guards)
  assert.ok(guards.gateBlocks >= blocked.length - 1 + 9)
  const hidden = await client.evaluate('window.faanginSmoke.liveFixture({type:"overlay-state"})')
  assert.equal(hidden.visible, false)
  report.checks.backendCaptureGenerationOverlayAndShortcutGuards = true

  const setupOffer = await client.evaluate(`(() => ({text:document.querySelector('.access-setup')?.textContent ?? '',checkboxes:document.querySelectorAll('.access-setup input[type="checkbox"]').length,osRows:document.querySelectorAll('.access-setup-row[data-permission]').length}))()`)
  assert.equal(setupOffer.checkboxes, 0); assert.equal(setupOffer.osRows, 3)
  assert.doesNotMatch(setupOffer.text, /screen-share privacy|hide from screen|undetect/i)
  report.checks.setupDoesNotOfferScreenShareHiding = true

  report.permissionMatrix = []
  for (const [missing, value] of [['microphone', 'denied'], ['screen', 'denied'], ['systemAudio', 'unavailable']]) {
    await mock(client, { permissions: { microphone: 'granted', screen: 'granted', systemAudio: 'verified', [missing]: value }, completed: true })
    const current = await access(client)
    assert.equal(current.ready, false); assert.equal(current.required, true)
    await gate(client)
    await assertBlocked(client, `Missing ${missing} despite saved completion`, `window.faangin.generate({sessionId:${sessionId},action:'assist',prompt:'Independent permission guard'})`)
    report.permissionMatrix.push({ missing, access: current })
  }
  noWork(await telemetry(client))
  report.checks.allThreePermissionsAreIndependentlyRequired = true

  await mock(client, { permissions: { microphone: 'denied', screen: 'not-determined', systemAudio: 'not-requested' }, completed: false, probeResult: 'denied' })
  await primary(client)
  await until('microphone denied guidance', () => client.evaluate(`document.querySelector('.access-setup-row[data-permission="microphone"]')?.textContent.includes('Blocked')`))
  assert.equal((await access(client)).ready, false)
  report.checks.deniedMicrophoneDoesNotBypass = true
  // No push notification: polling must detect the mocked OS change and continue the user's setup intent.
  await mock(client, { permissions: { microphone: 'granted', screen: 'granted', systemAudio: 'not-requested' }, probeResult: 'denied', notify: false })
  await until('automatic permission recheck and separate audio denial', async () => (await access(client)).permissions.systemAudio === 'denied')
  await until('audio denial feedback', () => client.evaluate('!!document.querySelector(".access-setup-error")'))
  assert.equal((await access(client)).ready, false)
  assert.equal(await client.evaluate(`document.querySelector('.access-setup-primary').textContent.includes('Continue')`), false)
  noWork(await telemetry(client))
  report.checks.automaticRecheckDoesNotInferComputerAudioFromScreen = true
  await checkLayout(client, 'denied-access')

  for (const outcome of ['timeout', 'unavailable']) {
    await mock(client, { permissions: { systemAudio: 'not-requested' }, probeResult: outcome })
    await primary(client)
    await until(`honest audio ${outcome} result`, async () => (await access(client)).permissions.systemAudio === 'unavailable')
    await until('audio error visible', () => client.evaluate('!!document.querySelector(".access-setup-error")'))
    const current = await telemetry(client)
    noWork(current)
    assert.equal(current.probeTracksStarted, current.probeTracksStopped)
  }
  report.checks.audioFailuresAndTimeoutCleanUpWithoutUnlocking = true

  await mock(client, { permissions: { systemAudio: 'not-requested' }, probeResult: 'success' })
  await primary(client)
  await until('all three permissions ready', async () => (await access(client)).ready)
  await until('Continue access action', () => client.evaluate(`document.querySelector('.access-setup-primary:not(:disabled)')?.textContent.includes('Continue')`))
  assert.equal((await access(client)).completed, false)
  await assertBlocked(client, 'Ready without explicit completion', `window.faangin.generate({sessionId:${sessionId},action:'assist',prompt:'Still gated'})`)
  const checked = await telemetry(client)
  noWork(checked)
  assert.ok(checked.probeTracksStarted >= 2); assert.equal(checked.probeTracksStarted, checked.probeTracksStopped)
  report.probeTelemetry = checked
  await checkLayout(client, 'ready-access')
  await primary(client)
  await until('access gate completed', () => client.evaluate('!document.querySelector(".access-setup")&&!!document.querySelector(".sidebar")'))
  const completed = await state(client)
  assert.equal(completed.accessSetup.completed, true); assert.equal(completed.accessSetup.required, false)
  assert.equal(completed.settings.microphone, true); assert.equal(completed.settings.systemAudio, true)
  assert.equal(completed.settings.liveSuggestions, false); assert.equal(completed.settings.privacyMode, false)
  assert.equal(completed.capture.active, false)
  noWork(await telemetry(client))
  report.checks.backgroundConfigurationRespectsChoiceAndDoesNotStartCapture = true

  // An owned synthetic capture exercises the actual lifecycle without opening any OS stream.
  await client.evaluate(`window.faanginSmoke.liveFixture({type:'start',sessionId:${sessionId}})`)
  await until('owned synthetic capture', async () => (await state(client)).capture.active)
  await mock(client, { permissions: { microphone: 'denied' }, notify: false })
  await until('revocation stops active synthetic capture', async () => !(await state(client)).capture.active)
  await gate(client)
  await assertBlocked(client, 'Generate after revocation', `window.faangin.generate({sessionId:${sessionId},action:'assist',prompt:'Revoked'})`)
  assert.equal((await telemetry(client)).cloudRequests, 0)
  report.checks.revocationStopsActiveWorkAndRestoresGate = true
  client.close(); client = undefined
  await stop(running); running = undefined

  running = launch('ready-restart.json')
  await ready(running); client = await connect(running)
  await gate(client)
  const restarted = await access(client)
  assert.equal(restarted.completed, true, 'Consent receipt must persist across a full app restart')
  assert.equal(restarted.required, true, 'A saved completion receipt cannot bypass newly missing permission')
  assert.equal(restarted.ready, false)
  noWork(await telemetry(client))
  await assertBlocked(client, 'Capture after restart with revoked permission', `window.faangin.captureScreen(${JSON.stringify((await state(client)).currentSession.id)})`)
  report.checks.persistedReceiptRechecksRevokedPermissions = true
  client.close(); client = undefined
  await stop(running); running = undefined

  // The completed receipt authorizes one fresh, bounded capability check on a subsequent launch.
  running = launch('ready-prior-consent.json', true)
  await ready(running); client = await connect(running)
  await until('one prior-consent startup check completes', async () => !(await access(client)).required)
  const startupChecks = await telemetry(client)
  noWork(startupChecks)
  assert.equal(startupChecks.backgroundAudioChecks, 1)
  assert.equal(startupChecks.systemAudioChecks, 1)
  assert.equal(startupChecks.permissionRequests, 0, 'Readiness recheck must use prior consent rather than silently replaying all permission requests')
  assert.equal(startupChecks.probeTracksStarted, startupChecks.probeTracksStopped)
  for (let index = 0; index < 4; index++) await client.evaluate('window.faangin.refreshAccessSetup()')
  const refreshed = await telemetry(client)
  assert.equal(refreshed.systemAudioChecks, 1, 'Read-only refreshes must never reopen audio streams')
  assert.equal(refreshed.backgroundAudioChecks, 1)
  assert.ok(refreshed.statusChecks >= startupChecks.statusChecks + 4)
  report.startupTelemetry = refreshed
  report.checks.priorConsentAllowsOneBoundedStartupCheck = true
  assert.deepEqual(report.rendererExceptions, [])
  report.checks.noRendererExceptions = true
  report.passed = true
  await rm(join(output, 'failure.png'), { force: true })
  console.log(`Required access QA passed for ${report.version}: permission-first UI, no bypass, independent microphone/screen/computer audio, direct IPC and shortcut guards, polling and error recovery, probe cleanup, consent/configuration, active-work revocation, and restart rechecks. ${report.appAsarSha256 ? 'Packaged app.asar SHA-256: ' + report.appAsarSha256 : 'Source build tested.'} Report: ${join(output, 'report.json')}`)
} catch (error) {
  report.passed = false; report.error = redact(error.stack || error.message)
  if (client) {
    try { report.failureState = await state(client); report.failureTelemetry = await telemetry(client) } catch {}
    try { await client.screenshot('failure.png') } catch {}
  }
  throw error
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  client?.close(); await stop(running)
  await rm(fixture, { recursive: true, force: true })
}
