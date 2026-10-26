#!/usr/bin/env node
/*
 * Isolated native QA. This script never injects input or captures screen/audio.
 * Start: node scripts/overlay-native-probe.cjs
 * Controls are native QA shortcuts (printed at startup) and owned window buttons.
 * Real clicks and typing must be supplied by the operator (for example, through CUA).
 */
const fs = require('node:fs')
const path = require('node:path')

const { spawn, execFileSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const root = path.resolve(__dirname, '..')
const actions = ['passive', 'interactive', 'output', 'hide', 'toggle', 'capture', 'recreate', 'dock-hide', 'dock-show', 'quit']
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function safeEnvironment(extra = {}) {
  const env = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', '__CF_USER_TEXT_ENCODING']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return { ...env, ...extra }
}

function writeJSON(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2))
  fs.renameSync(`${file}.tmp`, file)
}

async function launch() {
  if (process.platform !== 'darwin') throw new Error('This native AppKit fixture is for macOS.')
  const fixture = fs.mkdtempSync('/private/tmp/faangin-overlay-native-qa-')
  const bundle = path.join(fixture, 'Faangin Overlay QA Target.app')
  const executable = path.join(bundle, 'Contents', 'MacOS', 'OverlayQATarget')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  const cache = path.join(fixture, 'swift-cache')
  fs.mkdirSync(cache)
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>OverlayQATarget</string><key>CFBundleIdentifier</key><string>local.faangin.overlay-qa-target.${randomUUID()}</string><key>CFBundleName</key><string>Faangin Overlay QA Target</string><key>CFBundlePackageType</key><string>APPL</string><key>NSPrincipalClass</key><string>NSApplication</string></dict></plist>`)
  console.log(`Building owned native QA target in ${fixture}`)
  execFileSync('xcrun', ['swiftc', path.join(__dirname, 'overlay-native-probe', 'Underlay.swift'), '-o', executable, '-module-cache-path', cache], {
    env: safeEnvironment({ CLANG_MODULE_CACHE_PATH: cache, SWIFT_MODULECACHE_PATH: cache }), stdio: 'inherit', timeout: 90000
  })
  // A separate ordinary application identity keeps native automation from
  // binding another checkout registered as com.github.Electron.
  const overlayBundle = path.join(fixture, 'Faangin Overlay QA.app')
  const electronBundle = path.resolve(require('electron'), '../../..')
  execFileSync('/bin/cp', ['-cR', electronBundle, overlayBundle], { env: safeEnvironment(), stdio: 'inherit', timeout: 60000 })
  const plist = path.join(overlayBundle, 'Contents', 'Info.plist')
  for (const [key, value] of [
    ['CFBundleIdentifier', `local.faangin.overlay-native-qa.${randomUUID()}`],
    ['CFBundleName', 'Faangin Overlay QA'], ['CFBundleDisplayName', 'Faangin Overlay QA'],
    ['CFBundleExecutable', 'OverlayQA']
  ]) execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { env: safeEnvironment(), stdio: 'inherit' })
  const overlayExecutable = path.join(overlayBundle, 'Contents', 'MacOS', 'OverlayQA')
  fs.renameSync(path.join(overlayBundle, 'Contents', 'MacOS', 'Electron'), overlayExecutable)
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', overlayBundle], { env: safeEnvironment(), stdio: 'inherit', timeout: 60000 })
  const child = spawn(overlayExecutable, [__filename], {
    cwd: root, stdio: 'inherit', env: safeEnvironment({ FAANGIN_OVERLAY_QA_DIR: fixture })
  })
  const stop = () => { if (!child.killed) child.kill('SIGTERM') }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  child.once('error', error => { console.error(error.message); process.exitCode = 1 })
  child.once('exit', code => {
    process.exitCode = code ?? 1
    if (code !== 0) console.error(`Owned Electron QA process exited ${code ?? 'by signal'}. Reports, if available, remain in ${fixture}. A GUI launch may require the desktop execution permission.`)
  })
}

async function electronProbe() {
  const { app, BrowserWindow, ipcMain, globalShortcut, screen, session } = require('electron')
  const fixture = process.env.FAANGIN_OVERLAY_QA_DIR
  if (!fixture || !fs.existsSync(path.join(fixture, 'Faangin Overlay QA Target.app', 'Contents', 'MacOS', 'OverlayQATarget'))) throw new Error('Use the node launcher to create an isolated fixture first.')
  app.setPath('userData', path.join(fixture, 'electron-user-data'))
  app.setName('Faangin Overlay QA')
  app.commandLine.appendSwitch('disable-background-networking')
  app.commandLine.appendSwitch('force-renderer-accessibility')
  require('tsx/cjs')
  const { OverlayInteractionPolicy, MacDockPolicy } = require('../src/main/native-policy.ts')
  const { ScreenshotCapture } = require('../src/main/screenshot-capture.ts')
  const reportPath = path.join(fixture, 'overlay-report.json')
  const targetReportPath = path.join(fixture, 'target-report.json')

  const policy = new OverlayInteractionPolicy()
  let overlay, controller, target, dock, timer, quitting = false, sequence = 0
  let lastAction = 'starting', lastError, captureResult
  const counts = { clicks: 0, mouseMoves: 0, keyDowns: 0, focusEvents: 0 }
  const nativeCalls = []
  const shortcuts = {}
  const record = (method, argument) => {
    nativeCalls.push({ method, ...(argument !== undefined ? { argument } : {}) })
    if (nativeCalls.length > 24) nativeCalls.shift()
  }
  const readTarget = () => { try { return JSON.parse(fs.readFileSync(targetReportPath, 'utf8')) } catch { return null } }
  const state = () => ({
    schema: 1, sequence: ++sequence, pid: process.pid, fixture,
    policy: { passive: policy.passive, desiredVisible: policy.desiredVisible },
    overlay: !overlay || overlay.isDestroyed() ? null : {
      visible: overlay.isVisible(), focused: overlay.isFocused(), focusable: overlay.isFocusable(),
      bounds: overlay.getBounds(), rendererCounts: { ...counts }
    },
    controllerFocused: !!controller && !controller.isDestroyed() && controller.isFocused(),
    dockVisible: app.dock?.isVisible() ?? null, nativeCalls: [...nativeCalls], shortcuts,
    lastAction, ...(lastError ? { error: lastError } : {}), ...(captureResult ? { capture: captureResult } : {}),
    target: readTarget(), cleanup: { quitting, targetExited: target?.exitCode !== null },
    isolation: { disposableUserData: true, noNetwork: true, noProviders: true, noScreenOrAudioCapture: true, noInputInjection: true }
  })
  const save = () => {
    const report = state()
    writeJSON(reportPath, report)
    if (controller && !controller.isDestroyed() && !controller.webContents.isDestroyed()) controller.webContents.send('qa:state', report)
  }
  app.on('before-quit', () => {
    quitting = true; clearInterval(timer); globalShortcut.unregisterAll(); dock?.dispose()
    if (target && target.exitCode === null) target.kill('SIGTERM')
    save()
  })
  function attachOverlay(window) {
    // Instrument the exact arguments used by the production policy, without altering them.
    policy.attach({
      isDestroyed: () => window.isDestroyed(), isFocused: () => window.isFocused(),
      setIgnoreMouseEvents: (...args) => { record('setIgnoreMouseEvents', args); window.setIgnoreMouseEvents(...args) },
      setFocusable: value => { record('setFocusable', value); window.setFocusable(value) },
      blur: () => { record('blur'); window.blur() },
      showInactive: () => { record('showInactive'); window.showInactive() },
      show: () => { record('show'); window.show() }, focus: () => { record('focus'); window.focus() },
      hide: () => { record('hide'); window.hide() }
    })
  }
  function createOverlay(bounds) {
    const window = new BrowserWindow({ ...bounds, title: 'Faangin Overlay QA · Overlay', show: false,
      frame: false, transparent: true, alwaysOnTop: true, resizable: false,
      focusable: false, webPreferences: { preload: path.join(fixture, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    window.setAlwaysOnTop(true, 'floating')
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.on('focus', () => { counts.focusEvents++; save() })
    window.on('blur', save)
    attachOverlay(window)
    void window.loadFile(path.join(fixture, 'overlay.html'))
    return window
  }
  async function act(action) {
    if (!actions.includes(action) || quitting) return
    lastAction = action; lastError = undefined
    try {
      if (action === 'passive') { policy.setPassive(true); policy.showOutput() }
      else if (action === 'interactive') policy.showInteractive()
      else if (action === 'output') policy.showOutput()
      else if (action === 'hide') policy.hide()
      else if (action === 'toggle') policy.toggleVisibility()
      else if (action === 'dock-hide') dock.apply(true)
      else if (action === 'dock-show') dock.apply(false)
      else if (action === 'recreate') {
        const bounds = overlay.getBounds(); overlay.destroy(); overlay = createOverlay(bounds)
        await new Promise(resolve => overlay.webContents.once('did-finish-load', resolve))
        if (policy.desiredVisible) policy.showOutput()
      } else if (action === 'capture') {
        // Production exclusion/restoration, with a synthetic source: no desktopCapturer or pixels.
        const display = screen.getPrimaryDisplay()
        const before = { focused: overlay.isFocused(), passive: policy.passive, desiredVisible: policy.desiredVisible, target: readTarget() }
        const capture = new ScreenshotCapture({
          windows: () => BrowserWindow.getAllWindows(),
          watchWindows: listener => { const created = (_event, window) => listener(window); app.on('browser-window-created', created); return () => app.removeListener('browser-window-created', created) },
          displays: () => [{ id: String(display.id), width: display.size.width, height: display.size.height, scaleFactor: display.scaleFactor }],
          sources: async () => [{ id: `screen:${display.id}:0`, name: 'Owned synthetic QA source', display_id: String(display.id), thumbnail: { synthetic: true } }],
          quitting: () => quitting, mayRestore: window => window !== overlay || policy.desiredVisible,
          settle: () => delay(200), timeoutMs: 3000
        })
        await capture.capture({ sessionId: 'owned-overlay-qa', primaryDisplayId: String(display.id), assertCurrent() {} })
        captureResult = { synthetic: true, completed: true, before, after: { focused: overlay.isFocused(), visible: overlay.isVisible(), passive: policy.passive, desiredVisible: policy.desiredVisible, target: readTarget() } }
      } else if (action === 'quit') app.quit()
    } catch (error) { lastError = `${error.name}: ${error.message}` }
    save()
  }
  await app.whenReady()
  // Expose the owned controller buttons to native accessibility automation;
  // this changes no input routing and does not synthesize any input.
  app.setAccessibilitySupportEnabled(true)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let allowed = false
    try { const url = new URL(details.url); allowed = url.protocol === 'file:' && decodeURIComponent(url.pathname).startsWith(fixture + '/') } catch {}
    callback({ cancel: !allowed })
  })
  fs.writeFileSync(path.join(fixture, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('overlayQA',{action:action=>ipcRenderer.send('qa:action',action),event:kind=>ipcRenderer.send('qa:event',kind),state:callback=>ipcRenderer.on('qa:state',(_event,value)=>callback(value))});`)
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'unsafe-inline\'; connect-src \'none\'">'
  fs.writeFileSync(path.join(fixture, 'overlay.html'), `<!doctype html><html><head>${csp}<style>*{box-sizing:border-box;cursor:default!important}html,body{margin:0;width:100%;height:100%;font:16px -apple-system;color:white;background:rgba(45,30,100,.31)}.frame{border:4px solid #794dff;height:100%;padding:14px;position:relative}h2{margin:0;font-size:18px}.note{position:absolute;right:14px;bottom:12px;background:#32205a;padding:8px}.target{position:absolute;left:56px;top:150px;width:270px;height:56px;border:2px dashed white;background:rgba(60,15,100,.55);color:white;font-size:17px}.input{position:absolute;left:56px;top:260px;width:560px;height:44px;background:rgba(60,15,100,.45);border:2px dashed white;color:white;font-size:18px}</style></head><body><div class="frame"><h2>Faangin QA overlay · visible during passive input</h2><button class="target">Overlay click trap</button><input class="input" placeholder="Overlay input trap"><div class="note">Passive: clicks and keys belong to blue target below</div></div><script src="overlay.js"></script></body></html>`)
  fs.writeFileSync(path.join(fixture, 'overlay.js'), `for(const [event,kind] of [['click','clicks'],['mousemove','mouseMoves'],['keydown','keyDowns']])document.addEventListener(event,()=>window.overlayQA.event(kind),{passive:true});`)
  fs.writeFileSync(path.join(fixture, 'controller.html'), `<!doctype html><html><head>${csp}<style>body{font:14px -apple-system;background:#f3f5f9;color:#172030;margin:20px}button{font:14px -apple-system;margin:4px;padding:9px;cursor:default}pre{font:11px ui-monospace;white-space:pre-wrap;max-height:260px;overflow:auto}</style></head><body><h2>Overlay native QA controls</h2><p>Separate AppKit target receives all operator input. Purple overlay uses the production native policy.</p><p>Use real Control+Option+P to show passive output while the target stays focused. No input is injected. Control+Option+I restores interaction.</p>${actions.map(action => `<button data-action="${action}">${action}</button>`).join('')}<pre id="state">Waiting for report</pre><script src="controller.js"></script></body></html>`)
  fs.writeFileSync(path.join(fixture, 'controller.js'), `document.addEventListener('click',event=>{const action=event.target.dataset.action;if(action)window.overlayQA.action(action)});window.overlayQA.state(value=>document.getElementById('state').textContent=JSON.stringify({policy:value.policy,overlay:value.overlay,target:value.target,lastAction:value.lastAction,error:value.error},null,2));`)
  const work = screen.getPrimaryDisplay().workArea
  const x = Math.round(work.x + 50), y = Math.round(work.y + 80), width = 680, height = 430
  target = spawn(path.join(fixture, 'Faangin Overlay QA Target.app', 'Contents', 'MacOS', 'OverlayQATarget'), [targetReportPath, String(x), String(y), String(width), String(height)], { env: safeEnvironment(), stdio: ['ignore', 'ignore', 'inherit'] })
  target.once('error', error => { lastError = `Target launch failed: ${error.message}`; save() })
  const deadline = Date.now() + 8000
  while (!readTarget() && Date.now() < deadline && target.exitCode === null) await delay(100)
  const targetState = readTarget()
  if (!targetState) throw new Error('Owned native target did not become ready.')
  const bounds = Object.fromEntries(Object.entries(targetState.contentBounds).map(([key, value]) => [key, Math.round(value)]))
  overlay = createOverlay(bounds)
  controller = new BrowserWindow({ x: Math.min(x + width + 30, work.x + work.width - 420), y, width: 410, height: Math.min(670, work.height - 100), title: 'Faangin Overlay QA · Controls', show: false, webPreferences: { preload: path.join(fixture, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  controller.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  controller.webContents.on('will-navigate', event => event.preventDefault())
  await controller.loadFile(path.join(fixture, 'controller.html'))
  controller.showInactive()
  controller.on('closed', () => { controller = undefined; app.quit() })
  dock = new MacDockPolicy({ platform: process.platform, setActivationPolicy: value => app.setActivationPolicy(value), hide: () => app.dock.hide(), show: () => app.dock.show(), onError: error => { lastError = `Dock: ${error.message}` } })
  ipcMain.on('qa:action', (event, action) => { if (event.sender === controller?.webContents) void act(action) })
  ipcMain.on('qa:event', (event, kind) => {
    if (event.sender === overlay?.webContents && ['clicks', 'mouseMoves', 'keyDowns'].includes(kind)) { counts[kind]++; save() }
  })
  for (const [letter, action] of [['P', 'passive'], ['I', 'interactive'], ['H', 'hide'], ['O', 'output'], ['C', 'capture'], ['R', 'recreate'], ['D', 'dock-hide'], ['S', 'dock-show'], ['V', 'toggle'], ['Q', 'quit']]) {
    const shortcut = `Control+Alt+${letter}`
    shortcuts[shortcut] = globalShortcut.register(shortcut, () => { void act(action) })
  }
  timer = setInterval(save, 200)

  process.on('SIGTERM', () => app.quit()); process.on('SIGINT', () => app.quit())
  app.on('window-all-closed', () => app.quit())
  lastAction = 'ready-hidden'; save()
  console.log(JSON.stringify({ ready: true, fixture, overlayReport: reportPath, targetReport: targetReportPath, targetApp: path.join(fixture, 'Faangin Overlay QA Target.app'), overlayApp: path.resolve(app.getPath('exe'), '../../..'), targetBounds: bounds, shortcuts, instructions: 'Focus blue target with real CUA click; press Control+Option+P for background passive overlay; click target through purple overlay and type public text. Control+Option: I interactive, H hide, O background output, C synthetic capture restoration, R recreate, D hide Dock, S show Dock, V toggle, Q quit.' }, null, 2))
}

if (process.versions.electron) {
  void electronProbe().catch(error => { console.error(error.stack); require('electron').app.exit(1) })
} else {
  void launch().catch(error => { console.error(error.message); process.exitCode = 1 })
}
