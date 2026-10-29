/** Production BrowserWindow geometry regression. Never emulates viewport dimensions. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const configuredApp = process.env.FAANGIN_APP_PATH
const executable = configuredApp
  ? configuredApp.endsWith('.app') ? join(configuredApp, 'Contents', 'MacOS', 'Faangin') : configuredApp
  : require('electron')
const fixture = await mkdtemp(join(tmpdir(), 'faangin-native-layout-qa-'))
const output = process.env.FAANGIN_LAYOUT_QA_OUTPUT || join(root, 'output', 'qa', 'overlay-layout')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const redact = value => String(value).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
const report = {
  application: configuredApp || root,
  scope: 'Actual production BrowserWindow bounds, content bounds, min/max sizes, resize/fullscreen flags, native window-state restoration, trusted renderer pointer capture through CDP, and real IPC resize/reset commands. Disposable user data only; no provider calls, credentials, recording, or desktop capture.',
  viewportEmulationUsed: false,
  physicalOSPointerRoutingVerified: false,
  physicalDisplayTopologyChangesTested: false,
  checks: {}, nativeStates: [], screenshots: [], rendererExceptions: [],
}
await mkdir(output, { recursive: true })

function seedSettings(patch) {
  const db = new DatabaseSync(join(fixture, 'faangin.sqlite'))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL)')
    const row = db.prepare('SELECT json FROM settings WHERE id=1').get()
    const settings = { ...(row ? JSON.parse(row.json) : {}), ...patch }
    db.prepare('INSERT INTO settings(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(settings))
  } finally { db.close() }
}

async function seedWindow(bounds, display) {
  await writeFile(join(fixture, 'window-state.json'), JSON.stringify({ overlay: {
    version: 1, bounds, displayId: display ? String(display.id) : 'owned-disconnected-fixture-display',
    workArea: display?.workArea || { x: 0, y: 0, width: 9000, height: 6000 },
  } }), { mode: 0o600 })
}

function launch(markerName) {
  const marker = join(fixture, markerName), env = { ...process.env }
  for (const name of Object.keys(env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(name) || name.startsWith('FAANGIN_SMOKE')) delete env[name]
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'FAANGIN_QA_VISIBLE']) delete env[name]
  Object.assign(env, { FAANGIN_SMOKE: '1', FAANGIN_USER_DATA_DIR: fixture, FAANGIN_SMOKE_READY: marker, FAANGIN_SMOKE_LIVE_FIXTURE: '1', FAANGIN_SMOKE_ACCESS_FIXTURE: 'ready' })
  const flags = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']
  const child = spawn(executable, configuredApp ? flags : [root, ...flags], { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const running = { child, marker, logs: '', exitCode: undefined, spawnError: undefined }
  child.stdout.on('data', bytes => { running.logs = (running.logs + bytes.toString()).slice(-10000) })
  child.stderr.on('data', bytes => { running.logs = (running.logs + bytes.toString()).slice(-10000) })
  child.on('exit', code => { running.exitCode = code ?? -1 })
  child.on('error', error => { running.spawnError = error })
  return running
}

async function until(label, fn, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(35) }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function ready(running) {
  return until('isolated app startup', async () => {
    if (running.spawnError) throw running.spawnError
    if (running.exitCode !== undefined) throw new Error(`Isolated app exited (${running.exitCode}): ${redact(running.logs.slice(-1600))}`)
    let value
    try { value = JSON.parse(await readFile(running.marker, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
    if (value.error) throw new Error(redact(value.error))
    assert.equal(value.keyConfigured, false)
    assert.equal(value.security?.sandbox, true)
    assert.equal(value.security?.contextIsolation, true)
    assert.equal(value.security?.nodeIntegration, false)
    return value
  }, 35000)
}

async function stop(running) {
  if (!running?.child.pid || running.exitCode !== undefined) return
  const signal = value => { try { process.kill(process.platform === 'win32' ? running.child.pid : -running.child.pid, value) } catch { running.child.kill(value) } }
  signal('SIGTERM')
  await Promise.race([new Promise(resolve => running.child.once('exit', resolve)), delay(2500)])
  if (running.exitCode === undefined) {
    signal('SIGKILL')
    await Promise.race([new Promise(resolve => running.child.once('exit', resolve)), delay(1000)])
  }
}

async function connect(running, kind) {
  const url = await until(`${kind} loopback debugger`, async () => {
    let port = running.logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]
    if (!port) { try { port = (await readFile(join(fixture, 'DevToolsActivePort'), 'utf8')).split('\n')[0] } catch {} }
    if (!/^\d+$/.test(port || '')) return false
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
      const target = (await response.json()).find(value => {
        if (value.type !== 'page') return false
        try { const page = new URL(value.url); return page.protocol === 'file:' && page.pathname.endsWith('/index.html') && page.searchParams.get('window') === kind } catch { return false }
      })
      if (!target?.webSocketDebuggerUrl) return false
      const result = new URL(target.webSocketDebuggerUrl)
      assert.equal(result.protocol, 'ws:'); assert.equal(result.hostname, '127.0.0.1'); assert.equal(result.port, port)
      assert.ok(result.pathname.startsWith('/devtools/page/'))
      return result.href
    } catch (error) { if (error instanceof assert.AssertionError) throw error; return false }
  })
  const socket = new WebSocket(url, { handshakeTimeout: 3000, maxPayload: 16 * 1024 * 1024 })
  const pending = new Map()
  const fail = () => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('Native layout debugger disconnected.')) } pending.clear() }
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
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return {
    send,
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(redact(result.exceptionDetails.exception?.description || result.exceptionDetails.text))
      return result.result?.value
    },
    async screenshot(name) {
      const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      await writeFile(join(output, name), Buffer.from(result.data, 'base64')); report.screenshots.push(name)
    },
    async key(key, shift = false) {
      const code = { Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key]
      assert.ok(code)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0, ...(key === 'Enter' ? { text: '\r' } : {}) })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 })
    },
    close() { fail(); socket.close() },
  }
}

const native = client => client.evaluate('window.faanginSmoke.liveFixture({type:"overlay-state"})')
async function snapshot(client, label, collapsed = false) {
  const value = await native(client)
  const renderer = await client.evaluate('({width:innerWidth,height:innerHeight,outerWidth,outerHeight,ratio:devicePixelRatio})')
  report.nativeStates.push({ label, ...value, renderer })
  assert.equal(value.exists, true)
  assert.ok(value.display?.workArea, 'Native work area must be reported by Electron')
  const area = value.display.workArea, bounds = value.bounds
  const usableWidth = Math.max(1, area.width - 32), usableHeight = Math.max(1, area.height - 32)
  assert.equal(value.fullscreen, false, `${label}: overlay must never enter native fullscreen`)
  assert.equal(value.maximized, false, `${label}: overlay must never maximize`)
  assert.equal(value.maximizable, false)
  assert.equal(value.fullscreenable, false)
  assert.equal(value.resizable, !collapsed, `${label}: native resizability must follow collapsed state`)
  assert.deepEqual(value.minimumSize, [Math.min(360, usableWidth), Math.min(collapsed ? 54 : 400, usableHeight)])
  assert.deepEqual(value.maximumSize, [Math.min(720, usableWidth), Math.min(collapsed ? 54 : 840, usableHeight)])
  assert.ok(bounds.width >= value.minimumSize[0] && bounds.width <= value.maximumSize[0], `${label}: native width must respect limits`)
  assert.ok(bounds.height >= value.minimumSize[1] && bounds.height <= value.maximumSize[1], `${label}: native height must respect limits`)
  const insetX = Math.min(16, Math.max(0, (area.width - value.maximumSize[0]) / 2)), insetY = Math.min(16, Math.max(0, (area.height - value.maximumSize[1]) / 2))
  assert.ok(bounds.x >= area.x + insetX - 1 && bounds.y >= area.y + insetY - 1 && bounds.x + bounds.width <= area.x + area.width - insetX + 1 && bounds.y + bounds.height <= area.y + area.height - insetY + 1, `${label}: native window must remain reachable within its display gutter`)
  assert.equal(renderer.width, value.contentBounds.width, 'Renderer width must equal actual native content width, without viewport emulation')
  assert.equal(renderer.height, value.contentBounds.height, 'Renderer height must equal actual native content height, without viewport emulation')
  assert.equal(bounds.width, renderer.width, 'Frameless native width must equal renderer width')
  assert.equal(bounds.height, renderer.height, 'Frameless native height must equal renderer height')
  return value
}

async function settleSize(client, width, height) {
  await until(`actual native ${width}×${height} bounds`, async () => {
    const state = await native(client)
    return state.bounds?.width === width && state.bounds?.height === height && await client.evaluate(`innerWidth===${width}&&innerHeight===${height}`)
  })
  await client.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
}

async function checkUI(client) {
  const ui = await client.evaluate(`(() => {
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
    const grip=document.querySelector('.overlay-resize-handle'),composer=document.querySelector('.composer'),header=document.querySelector('.overlay-topbar');
    return {width:innerWidth,height:innerHeight,pageWidth:document.body.scrollWidth,grip:grip&&{...rect(grip),cursor:getComputedStyle(grip).cursor,drag:getComputedStyle(grip).webkitAppRegion},composer:composer&&rect(composer),header:rect(header),controls:[...header.querySelectorAll('button,summary')].filter(e=>e.getClientRects().length&&e.closest('header')===header&&!e.closest('.overlay-more-panel')).map(e=>({label:e.getAttribute('aria-label')||e.textContent.trim(),...rect(e)}))};
  })()`)
  assert.ok(ui.pageWidth <= ui.width + 1)
  assert.ok(ui.grip && ui.grip.width >= 24 && ui.grip.height >= 24 && ui.grip.right <= ui.width && ui.grip.bottom <= ui.height, 'Resize grip must remain reachable inside the real window')
  assert.equal(ui.grip.cursor, 'nwse-resize'); assert.equal(ui.grip.drag, 'no-drag')
  assert.ok(ui.composer && ui.composer.bottom <= ui.height && ui.composer.y >= ui.header.bottom, 'Composer must fit the native window')
  for (const control of ui.controls) assert.ok(control.x >= 0 && control.right <= ui.width && control.y >= 0 && control.bottom <= ui.height, `${control.label} must remain reachable`)
  return ui
}

async function pointerResize(client, dx, dy) {
  const before = await native(client)
  const start = await client.evaluate(`(() => {const r=document.querySelector('.overlay-resize-handle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0 })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 })
  await until('trusted resize pointer capture', () => client.evaluate('document.querySelector(".overlay-resize-handle").dataset.resizing==="true"'))
  for (const fraction of [.25, .5, .75, 1]) {
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + dx * fraction, y: start.y + dy * fraction, button: 'left', buttons: 1 })
    await delay(60)
  }
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + dx, y: start.y + dy, button: 'left', buttons: 0, clickCount: 1 })
  await until('resize pointer release', () => client.evaluate('!document.querySelector(".overlay-resize-handle").dataset.resizing'))
  const expectedWidth = Math.max(before.minimumSize[0], Math.min(before.maximumSize[0], before.bounds.width + dx))
  const expectedHeight = Math.max(before.minimumSize[1], Math.min(before.maximumSize[1], before.bounds.height + dy))
  await settleSize(client, expectedWidth, expectedHeight)
  return { before: before.bounds, after: (await native(client)).bounds, dx, dy, trustedRendererEvents: true, physicalOSRouting: false }
}

async function moreClick(client, label) {
  await client.evaluate(`(() => {const menu=document.querySelector('.overlay-more');if(!menu.open)menu.querySelector('summary').click();})()`)
  await until('More menu controls', () => client.evaluate('document.querySelector(".overlay-more").open'))
  await client.evaluate(`(() => {const button=[...document.querySelectorAll('.overlay-more-panel button')].find(value=>(value.getAttribute('aria-label')||value.textContent.trim())===${JSON.stringify(label)});if(!button||button.disabled)throw new Error('Missing enabled sizing control');button.click();})()`)
}

let running, workspace, overlay
async function open(marker) {
  running = launch(marker)
  const startup = await ready(running); report.version = startup.version
  workspace = await connect(running, 'workspace')
  const state = await workspace.evaluate('window.faangin.getState()')
  assert.equal(state.capture.active, false); assert.equal(state.keyConfigured, false)
  const surface = await until('workspace or first-run guide', () => workspace.evaluate(`document.querySelector('.onboarding')?'guide':document.querySelector('.sidebar')?'workspace':false`))
  if (surface === 'guide') {
    await workspace.evaluate(`document.querySelector('.onboarding-footer [data-onboarding-skip]').click()`)
    await until('workspace after explicit explore', () => workspace.evaluate('!!document.querySelector(".sidebar")'))
  }
  await workspace.evaluate('window.faangin.updateSettings({opacity:.94,theme:"light"})')
  await workspace.evaluate('window.faangin.openWindow("overlay")')
  overlay = await connect(running, 'overlay')
  await until('native overlay renderer', () => overlay.evaluate('!!document.querySelector(".overlay-topbar")'))
}
async function close() {
  overlay?.close(); overlay = undefined
  workspace?.close(); workspace = undefined
  await stop(running); running = undefined
}

try {
  if (configuredApp?.endsWith('.app')) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(configuredApp, 'Contents', 'Resources', 'app.asar'))) hash.update(chunk)
    report.appAsarSha256 = hash.digest('hex')
  }
  seedSettings({ overlayExpandedHeight: 9999, overlayCollapsed: false, theme: 'light', opacity: .94 })
  await seedWindow({ x: 90000, y: -90000, width: 9000, height: 6000 })
  await open('ready-oversized.json')
  const recovered = await snapshot(overlay, 'stale-fullscreen-and-disconnected-display-recovery')
  assert.equal(recovered.bounds.width, 480)
  assert.equal(recovered.bounds.height, 560)
  report.checks.staleFullscreenAndHugePreferenceRecover = true
  await overlay.screenshot('recovered-native-480x560.png')

  await overlay.evaluate('window.faangin.resizeOverlay({width:360,height:400})')
  await settleSize(overlay, 360, 400)
  await snapshot(overlay, 'actual-native-minimum-360x400')
  report.minimumUI = await checkUI(overlay)
  await overlay.screenshot('minimum-native-360x400.png')
  report.pointerGrow = await pointerResize(overlay, 80, 64)
  await snapshot(overlay, 'pointer-grown-native-window')
  report.pointerShrink = await pointerResize(overlay, -120, -100)
  await snapshot(overlay, 'pointer-clamped-at-native-minimum')
  report.checks.pointerGripChangesActualNativeBounds = true

  await overlay.evaluate('document.querySelector(".overlay-resize-handle").focus()')
  await overlay.key('ArrowRight')
  await settleSize(overlay, 376, 400)
  await overlay.key('ArrowDown', true)
  await settleSize(overlay, 376, 464)
  await snapshot(overlay, 'keyboard-native-resize')
  report.checks.keyboardResize16And64 = true

  await overlay.evaluate('window.faangin.resizeOverlay({width:9999,height:9999})')
  const max = await native(overlay)
  await settleSize(overlay, max.maximumSize[0], max.maximumSize[1])
  await snapshot(overlay, 'oversized-request-clamped-to-native-maximum')
  report.checks.nativeMaximumPreventsFullscreen = true

  await moreClick(overlay, 'Use comfortable overlay size')
  await settleSize(overlay, 600, 720)
  await snapshot(overlay, 'comfortable-menu-preset')
  await moreClick(overlay, 'Use compact overlay size')
  await settleSize(overlay, 480, 560)
  await snapshot(overlay, 'compact-menu-preset')
  await moreClick(overlay, 'Reset size & position')
  await settleSize(overlay, 480, 560)
  await snapshot(overlay, 'renderer-menu-reset')
  report.checks.menuPresetsAndReset = true

  await overlay.evaluate('window.faangin.resizeOverlay({width:392,height:432})')
  await settleSize(overlay, 392, 432)
  const remembered = await snapshot(overlay, 'intentional-size-before-collapse')
  await overlay.evaluate('window.faangin.updateSettings({overlayCollapsed:true})')
  await settleSize(overlay, 392, 54)
  await snapshot(overlay, 'collapsed-native-54', true)
  await overlay.screenshot('collapsed-native-392x54.png')
  await overlay.evaluate(`document.querySelector('[aria-label="Expand overlay"]').click()`)
  await settleSize(overlay, 392, 432)
  await snapshot(overlay, 'expanded-restores-intentional-native-size')
  report.checks.collapseAndExpandRestoreNativeSize = true
  await until('native geometry saved', async () => {
    try { const saved = JSON.parse(await readFile(join(fixture, 'window-state.json'), 'utf8')); return saved.overlay?.bounds.width === 392 && saved.overlay?.bounds.height === 432 } catch { return false }
  })
  await close()

  await open('ready-restart.json')
  const restarted = await snapshot(overlay, 'native-size-restored-after-full-restart')
  assert.deepEqual(restarted.bounds, remembered.bounds)
  report.checks.nativeSizePersistsAcrossRestart = true
  await close()

  seedSettings({ overlayCollapsed: false, overlayExpandedHeight: 949 })
  await seedWindow({ x: recovered.display.workArea.x, y: recovered.display.workArea.y, width: 1512, height: 949 }, recovered.display)
  await open('ready-v040-regression.json')
  const userRegression = await snapshot(overlay, 'v040-1512x949-and-height949-regression')
  assert.equal(userRegression.bounds.width, 480)
  assert.equal(userRegression.bounds.height, 560)
  report.checks.v040Fullscreen1512x949Recovers = true
  await close()

  seedSettings({ overlayCollapsed: true, overlayExpandedHeight: 9999 })
  await seedWindow({ x: -90000, y: 90000, width: 9000, height: 54 })
  await open('ready-collapsed-stale.json')
  const collapsed = await snapshot(overlay, 'stale-collapsed-full-width-recovered', true)
  assert.equal(collapsed.bounds.width, 480)
  await overlay.evaluate(`document.querySelector('[aria-label="Expand overlay"]').click()`)
  await settleSize(overlay, 480, 560)
  await snapshot(overlay, 'huge-expanded-height-falls-back-after-stale-collapse')
  report.checks.staleCollapsedAndHugeExpandedHeightRecover = true

  await overlay.evaluate('window.faangin.resizeOverlay({width:360,height:400})')
  await settleSize(overlay, 360, 400)
  await overlay.evaluate('window.faangin.setClickThrough(true)')
  await workspace.evaluate('window.faangin.resetOverlayLayout()')
  await settleSize(overlay, 480, 560)
  assert.equal((await native(overlay)).passive, true, 'Direct reset must preserve an explicit interaction preference')
  const menuReset = await workspace.evaluate('window.faanginSmoke.liveFixture({type:"overlay-reset-menu"})')
  assert.equal(menuReset.invoked, true)
  await until('native menu reset restores interaction', async () => !(await native(overlay)).passive)
  await snapshot(overlay, 'native-menu-reset-recovery')
  report.checks.workspaceFallbackAndNativeMenuReset = true
  await overlay.evaluate('window.faangin.resizeOverlay({width:360,height:400})')
  await settleSize(overlay, 360, 400)
  await workspace.evaluate('window.faangin.openWindow("workspace","settings")')
  await until('Settings categories', () => workspace.evaluate('!!document.querySelector(".settings-nav")'))
  await workspace.evaluate(`[...document.querySelectorAll('.settings-nav button')].find(value=>value.textContent.trim()==='Appearance').click()`)
  await until('Settings reset control', () => workspace.evaluate(`[...document.querySelectorAll('.settings-content button')].some(value=>value.textContent.trim()==='Reset overlay size & position')`))
  await workspace.evaluate(`(() => {const button=[...document.querySelectorAll('.settings-content button')].find(value=>value.textContent.trim()==='Reset overlay size & position');button.scrollIntoView({block:'center'});button.click();})()`)
  await settleSize(overlay, 480, 560)
  await snapshot(overlay, 'workspace-settings-reset-control')
  report.checks.settingsResetControl = true
  assert.equal((await overlay.evaluate('window.faangin.getState()')).capture.active, false)
  assert.deepEqual(report.rendererExceptions, [])
  report.checks.noRecordingOrRendererExceptions = true
  report.passed = true
  await rm(join(output, 'failure.png'), { force: true })
  console.log(`Native overlay layout QA passed for ${report.version}: stale fullscreen/offscreen geometry, huge saved height, actual BrowserWindow min/max and resizability, trusted pointer resize at 360px, keyboard resize, presets, renderer/native resets, collapsed 54px recovery, and full-restart sizing. ${report.appAsarSha256 ? 'Packaged app.asar SHA-256: ' + report.appAsarSha256 : 'Source build tested.'} Report: ${join(output, 'report.json')}`)
} catch (error) {
  report.passed = false; report.error = redact(error.stack || error.message)
  if (overlay) {
    try { report.failureNativeState = await native(overlay) } catch {}
    try { await overlay.screenshot('failure.png') } catch {}
  }
  throw error
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await close()
  await rm(fixture, { recursive: true, force: true })
}
