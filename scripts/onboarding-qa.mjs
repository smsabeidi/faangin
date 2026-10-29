/** First-run UX regression in a disposable Electron profile. No credentials or recording. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
const fixture = await mkdtemp(join(tmpdir(), 'faangin-onboarding-qa-'))
const output = process.env.FAANGIN_ONBOARDING_QA_OUTPUT || join(root, 'output', 'qa', 'onboarding')
const storageKey = 'faangin.onboarding.v1'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const redact = value => String(value).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
const report = {
  scope: 'Disposable local profile with explicitly completed fixture access, renderer DOM/CDP keyboard events, fixture permission status reads, and app restart. No provider calls, credentials, OS permission prompts, screenshots of other apps, or recording.',
  checks: {}, viewports: [], overlayViewports: [], rendererExceptions: [], screenshots: [],
  nativePermissionPromptsTested: false,
}
await mkdir(output, { recursive: true })

function launch(markerName) {
  const marker = join(fixture, markerName)
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(name) || name.startsWith('FAANGIN_SMOKE')) delete env[name]
  }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'FAANGIN_QA_VISIBLE']) delete env[name]
  Object.assign(env, { FAANGIN_SMOKE: '1', FAANGIN_USER_DATA_DIR: fixture, FAANGIN_SMOKE_READY: marker, FAANGIN_SMOKE_ACCESS_FIXTURE: 'ready' })
  const flags = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']
  const child = spawn(executable, configuredApp ? flags : [root, ...flags], {
    cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })
  const running = { child, marker, logs: '', exitCode: undefined, spawnError: undefined }
  child.stdout.on('data', data => { running.logs = (running.logs + data.toString()).slice(-10000) })
  child.stderr.on('data', data => { running.logs = (running.logs + data.toString()).slice(-10000) })
  child.on('exit', code => { running.exitCode = code ?? -1 })
  child.on('error', error => { running.spawnError = error })
  return running
}

async function until(label, check, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(40)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function ready(running) {
  return until('isolated app startup', async () => {
    if (running.spawnError) throw running.spawnError
    if (running.exitCode !== undefined) throw new Error(`App exited (${running.exitCode}): ${redact(running.logs.slice(-1000))}`)
    let value
    try { value = JSON.parse(await readFile(running.marker, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
    if (value.error) throw new Error(`Isolated startup failed: ${redact(value.error)}`)
    assert.equal(value.rendererReady, true)
    assert.equal(value.keyConfigured, false, 'The QA profile must have no provider credential')
    assert.equal(value.security?.sandbox, true)
    assert.equal(value.security?.contextIsolation, true)
    assert.equal(value.security?.nodeIntegration, false)
    return value
  }, 35000)
}

async function stop(running) {
  if (!running?.child.pid || running.exitCode !== undefined) return
  const signal = value => {
    try { process.kill(process.platform === 'win32' ? running.child.pid : -running.child.pid, value) }
    catch { running.child.kill(value) }
  }
  signal('SIGTERM')
  await Promise.race([new Promise(resolve => running.child.once('exit', resolve)), delay(2000)])
  if (running.exitCode === undefined) {
    signal('SIGKILL')
    await Promise.race([new Promise(resolve => running.child.once('exit', resolve)), delay(1000)])
  }
}

async function connect(running, kind = 'workspace') {
  const target = await until(`isolated ${kind} debugger`, async () => {
    let port = running.logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]
    if (!port) { try { port = (await readFile(join(fixture, 'DevToolsActivePort'), 'utf8')).split('\n')[0] } catch {} }
    if (!/^\d+$/.test(port || '')) return false
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
      const targets = await response.json()
      const page = targets.find(value => {
        if (value.type !== 'page') return false
        try { const url = new URL(value.url); return url.protocol === 'file:' && url.pathname.endsWith('/index.html') && url.searchParams.get('window') === kind }
        catch { return false }
      })
      if (!page?.webSocketDebuggerUrl) return false
      const url = new URL(page.webSocketDebuggerUrl)
      assert.equal(url.protocol, 'ws:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, port)
      assert.ok(url.pathname.startsWith('/devtools/page/'))
      return url.href
    } catch (error) { if (error instanceof assert.AssertionError) throw error; return false }
  })
  const socket = new WebSocket(target, { handshakeTimeout: 3000, maxPayload: 16 * 1024 * 1024 })
  const pending = new Map()
  const fail = () => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('Workspace debugger disconnected.')) } pending.clear() }
  socket.on('error', fail); socket.on('close', fail)
  socket.on('message', bytes => {
    const value = JSON.parse(bytes.toString())
    if (value.method === 'Runtime.exceptionThrown') {
      const details = value.params?.exceptionDetails
      report.rendererExceptions.push(redact(details?.exception?.description || details?.text || 'Unknown renderer exception').slice(0, 1800))
    }
    const job = pending.get(value.id)
    if (!job) return
    pending.delete(value.id); clearTimeout(job.timer)
    if (value.error) job.reject(new Error(`Debugger request failed: ${redact(value.error.message)}`))
    else job.resolve(value.result)
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  let sequence = 0
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)) }, 15000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }), error => {
      if (!error) return
      const job = pending.get(id)
      if (job) { pending.delete(id); clearTimeout(job.timer); job.reject(error) }
    })
  })
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return {
    send,
    async evaluate(expression) {
      const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (value.exceptionDetails) throw new Error(redact(value.exceptionDetails.exception?.description || value.exceptionDetails.text))
      return value.result?.value
    },
    async screenshot(name) {
      const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      assert.equal(typeof result.data, 'string')
      await writeFile(join(output, name), Buffer.from(result.data, 'base64'))
      report.screenshots.push(name)
    },
    async key(key, shift = false) {
      const code = { Tab: 9, Escape: 27, Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key]
      assert.ok(code, `Unsupported QA key: ${key}`)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0, ...(key === 'Enter' ? { text: '\r' } : {}) })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 })
    },
    close() { fail(); socket.close() },
  }
}

async function step(client, value) {
  await until(`onboarding step ${value + 1}`, () => client.evaluate(`!!document.querySelector('.onboarding[data-onboarding-step="${value}"]')`))
  await client.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

async function click(client, label, selector = '.onboarding button') {
  await client.evaluate(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(value => (value.getAttribute('aria-label') || value.textContent).trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) throw new Error(${JSON.stringify(`Missing enabled button: ${label}`)});
    button.click();
  })()`)
}

async function checkLayout(client, index) {
  for (const [width, height] of [[1000, 650], [900, 550]]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await client.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const geometry = await client.evaluate(`(() => {
      const dialog = document.querySelector('.onboarding');
      const main = dialog?.querySelector('.onboarding-main');
      const footer = dialog?.querySelector('.onboarding-footer');
      const connection = dialog?.querySelector('.onboarding-connection');
      const bounds = value => { const r=value.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height} };
      return {
        width:innerWidth,height:innerHeight,pageWidth:document.body.scrollWidth,
        dialog:dialog&&bounds(dialog),dialogWidth:dialog?.clientWidth,dialogContentWidth:dialog?.scrollWidth,
        main:main&&{...bounds(main),scrollHeight:main.scrollHeight,clientHeight:main.clientHeight},
        footer:footer&&bounds(footer),
        connection:connection&&bounds(connection),
        buttons:[...footer?.querySelectorAll('button')||[]].filter(b=>b.getBoundingClientRect().width>0).map(b=>({label:b.textContent.trim(),...bounds(b)})),
        progress:[...dialog.querySelectorAll('.onboarding-progress>.onboarding-step')].map(value=>({label:value.children[1]?.textContent.trim(),width:value.clientWidth,contentWidth:value.scrollWidth,labelBounds:bounds(value.children[1])})),
      };
    })()`)
    assert.ok(geometry.dialog, 'Onboarding dialog must exist')
    assert.ok(geometry.dialog.left >= -1 && geometry.dialog.right <= width + 1, 'Dialog must fit viewport width')
    assert.ok(geometry.dialog.top >= -1 && geometry.dialog.bottom <= height + 1, 'Dialog must fit viewport height')
    assert.ok(geometry.pageWidth <= width + 1, 'Onboarding must not cause horizontal page overflow')
    assert.ok(geometry.dialogContentWidth <= geometry.dialogWidth + 1, 'Dialog content must not overflow horizontally')
    assert.ok(geometry.main?.clientHeight > 100, 'Content needs a usable scroll region')
    assert.ok(geometry.footer && geometry.buttons.length, 'A persistent navigation footer must exist')
    if (index === 3) assert.ok(geometry.connection && geometry.connection.top >= geometry.main.top - 1 && geometry.connection.bottom <= geometry.main.bottom + 1, 'The AI connection callout must remain visible above the Ready footer')
    assert.equal(geometry.progress.length, 4, 'The guide must show four readable progress steps')
    for (let position = 0; position < geometry.progress.length; position++) {
      const current = geometry.progress[position], next = geometry.progress[position + 1]
      assert.ok(current.contentWidth <= current.width + 1, `${current.label} progress contents must fit their step`)
      if (next) assert.ok(current.labelBounds.right + 4 <= next.labelBounds.left, 'Adjacent progress labels must not overlap')
    }
    for (const button of geometry.buttons) {
      assert.ok(button.top >= -1 && button.bottom <= height + 1 && button.left >= -1 && button.right <= width + 1, `${button.label} must remain visible`)
      assert.ok(button.height >= 32, `${button.label} must have an accessible click target`)
    }
    report.viewports.push({ step: index + 1, ...geometry })
    await client.screenshot(`step-${index + 1}-${width}x${height}.png`)
  }
}

async function checkFocus(client) {
  assert.equal(await client.evaluate(`document.querySelector('.onboarding')?.contains(document.activeElement)`), true, 'Opening the guide must focus its dialog')
  const count = await client.evaluate(`(() => {
    const root=document.querySelector('.onboarding');
    const controls=[...root.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')].filter(e=>e.getBoundingClientRect().width>0&&getComputedStyle(e).visibility!=='hidden');
    window.__onboardingQaControls=controls; controls.at(-1).focus(); return controls.length;
  })()`)
  assert.ok(count > 1)
  await client.key('Tab')
  assert.equal(await client.evaluate('document.activeElement===window.__onboardingQaControls[0]'), true, 'Tab from the last control must wrap inside the guide')
  await client.key('Tab', true)
  assert.equal(await client.evaluate('document.activeElement===window.__onboardingQaControls.at(-1)'), true, 'Shift+Tab from the first control must wrap inside the guide')
  await client.evaluate('delete window.__onboardingQaControls')
}

async function checkOverlay(running, workspace) {
  await workspace.evaluate('window.faangin.updateSettings({theme:"dark",opacity:.94,overlayCollapsed:false})')
  await workspace.evaluate('window.faangin.openWindow("overlay")')
  const overlay = await connect(running, 'overlay')
  try {
    await until('overlay header', () => overlay.evaluate('!!document.querySelector(".overlay-topbar")'))
    assert.equal((await overlay.evaluate('window.faangin.getState()')).capture.active, false)
    assert.equal(await overlay.evaluate('!!document.querySelector(".onboarding")'), false, 'First-run guide belongs in the workspace')
    for (const theme of ['dark', 'light']) {
      await overlay.evaluate(`window.faangin.updateSettings({theme:${JSON.stringify(theme)},opacity:.94})`)
      await until(`${theme} overlay theme`, () => overlay.evaluate(`!!document.querySelector('.overlay-app.theme-${theme}')`))
      for (const [width, height] of [[480, 560], [360, 550]]) {
        await overlay.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        await overlay.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        const geometry = await overlay.evaluate(`(() => {
          const app=document.querySelector('.overlay-app'),header=document.querySelector('.overlay-topbar'),composer=document.querySelector('.composer');
          const bounds=value=>{const r=value.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
          return {width:innerWidth,height:innerHeight,pageWidth:document.body.scrollWidth,app:bounds(app),header:bounds(header),composer:composer&&bounds(composer),controls:[...header.querySelectorAll('button,summary')].filter(e=>e.getClientRects().length).map(e=>({label:e.getAttribute('aria-label')||e.textContent.trim(),drag:getComputedStyle(e).webkitAppRegion,...bounds(e)}))};
        })()`)
        assert.ok(geometry.pageWidth <= width + 1, 'Overlay must not overflow horizontally')
        assert.ok(geometry.composer && geometry.composer.bottom <= height + 1 && geometry.composer.top > geometry.header.bottom, 'Composer must remain visible below content')
        for (const control of geometry.controls) {
          assert.ok(control.left >= -1 && control.right <= width + 1, `${control.label} must fit the overlay header`)
          assert.ok(control.height >= 30, `${control.label} needs a useful pointer target`)
          assert.equal(control.drag, 'no-drag', `${control.label} must receive pointer events`)
        }
        report.overlayViewports.push({ theme, ...geometry })
        await overlay.screenshot(`overlay-${theme}-${width}x${height}.png`)
      }
    }
    report.checks.overlayFitsBothThemesAndSizes = true

    await overlay.evaluate('document.querySelector(".overlay-more>summary").focus()')
    await overlay.key('Enter')
    await until('More menu opening with Enter', () => overlay.evaluate('document.querySelector(".overlay-more").open&&document.querySelector(".overlay-more>summary").getAttribute("aria-expanded")==="true"'))
    assert.equal(await overlay.evaluate('document.querySelector(".overlay-more>summary").getAttribute("aria-expanded")'), 'true')
    await overlay.key('Escape')
    await until('Escape closing More', () => overlay.evaluate('!document.querySelector(".overlay-more").open'))
    assert.equal(await overlay.evaluate('document.activeElement===document.querySelector(".overlay-more>summary")'), true, 'Escape must restore focus to More')
    await overlay.key('ArrowDown')
    await until('More opening with ArrowDown', () => overlay.evaluate('document.querySelector(".overlay-more").open&&document.querySelector(".overlay-more-panel").contains(document.activeElement)'))
    const menu = await overlay.evaluate(`(() => {const p=document.querySelector('.overlay-more-panel'),r=p.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,height:r.height,clientHeight:p.clientHeight,scrollHeight:p.scrollHeight,viewportHeight:innerHeight,viewportWidth:innerWidth};})()`)
    assert.ok(menu.left >= -1 && menu.right <= menu.viewportWidth + 1 && menu.top >= -1 && menu.bottom <= menu.viewportHeight + 1, 'More menu must fit the small overlay with a scrollable body')
    report.overlayMenu = menu
    await overlay.screenshot('overlay-menu-light-360x550.png')
    await overlay.key('Escape')
    report.checks.overlayMenuKeyboardAndFit = true

    report.overlayOpacity = []
    for (const opacity of [0, .94]) {
      await overlay.evaluate(`window.faangin.updateSettings({opacity:${opacity}})`)
      await until(`overlay opacity ${opacity}`, () => overlay.evaluate(`Number(document.querySelector('.overlay-app').style.getPropertyValue('--overlay-opacity'))===${opacity}`))
      const colors = await overlay.evaluate(`(() => {
        const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
        const alpha=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return ctx.getImageData(0,0,1,1).data[3]/255};
        const app=getComputedStyle(document.querySelector('.overlay-app')),composer=getComputedStyle(document.querySelector('.composer')),capture=getComputedStyle(document.querySelector('.overlay-capture-button'));
        return {background:app.backgroundColor,backgroundAlpha:alpha(app.backgroundColor),composer:composer.backgroundColor,composerAlpha:alpha(composer.backgroundColor),textAlpha:alpha(app.color),captureAlpha:alpha(capture.backgroundColor),elementOpacity:Number(app.opacity)};
      })()`)
      assert.ok(Math.abs(colors.backgroundAlpha - opacity) < .012, 'User opacity must control the overlay background')
      assert.ok(Math.abs(colors.composerAlpha - opacity) < .012, 'User opacity must also control composer material')
      assert.equal(colors.textAlpha, 1, 'Text must remain readable independently of background opacity')
      assert.equal(colors.captureAlpha, 1, 'Primary controls must remain readable independently of background opacity')
      assert.equal(colors.elementOpacity, 1, 'Opacity must not fade the entire overlay')
      report.overlayOpacity.push({ opacity, ...colors })
    }
    report.checks.overlayOpacityPreservesReadableControls = true

    await overlay.send('Emulation.clearDeviceMetricsOverride')
    await overlay.evaluate('window.faangin.updateSettings({overlayCollapsed:true})')
    await until('native collapsed overlay height', () => overlay.evaluate('!!document.querySelector(".overlay-collapsed")&&innerHeight===54'))
    const collapsed = await overlay.evaluate(`(() => {const header=document.querySelector('.overlay-topbar');return {width:innerWidth,height:innerHeight,outerHeight,headerHeight:header.getBoundingClientRect().height,expand:!!header.querySelector('[aria-label="Expand overlay"]'),composerHidden:getComputedStyle(document.querySelector('.composer')).display==='none'};})()`)
    report.collapsedOverlay = collapsed
    assert.equal(collapsed.height, 54)
    assert.equal(collapsed.outerHeight, 54)
    assert.ok(collapsed.headerHeight <= 54, `Collapsed header must fit native height: ${JSON.stringify(collapsed)}`)
    assert.equal(collapsed.expand, true, 'Collapsed overlay must expose Expand')
    assert.equal(collapsed.composerHidden, true, 'Collapsed overlay must hide composer')
    await overlay.screenshot('overlay-collapsed-native-54.png')
    await overlay.evaluate(`document.querySelector('[aria-label="Expand overlay"]').click()`)
    await until('expanded overlay', () => overlay.evaluate('!document.querySelector(".overlay-collapsed")&&innerHeight>54'))
    assert.equal((await overlay.evaluate('window.faangin.getState()')).capture.active, false)
    report.checks.overlayNativeCollapseAndExpand = true
  } catch (error) {
    try { await overlay.screenshot('overlay-failure.png') } catch {}
    throw error
  } finally {
    overlay.close()
    await workspace.evaluate('window.faangin.hideOverlay()')
  }
}

let running, client
try {
  running = launch('ready-first.json')
  const startup = await ready(running)
  report.version = startup.version
  client = await connect(running)
  await step(client, 0)
  const first = await client.evaluate('window.faangin.getState()')
  assert.equal(first.keyConfigured, false)
  assert.equal(first.capture.active, false)
  assert.equal(first.chatConfigured, false)
  assert.equal(await client.evaluate(`document.querySelector('.onboarding')?.getAttribute('role')`), 'dialog')
  assert.equal(await client.evaluate(`document.querySelector('.onboarding')?.getAttribute('aria-modal')`), 'true')
  report.checks.firstLaunchAndHonestState = true
  await checkLayout(client, 0)
  await checkFocus(client)
  report.checks.keyboardFocusContained = true

  await click(client, 'Get started')
  await step(client, 1)
  const modes = await client.evaluate(`(() => {
    const options=[...document.querySelectorAll('.onboarding [role="radio"]')];
    const meeting=options.find(value=>value.textContent.includes('Meetings'));
    if (!meeting) throw new Error('Meeting workspace choice is missing');
    meeting.click(); meeting.focus(); return options.length;
  })()`)
  assert.equal(modes, 2, 'The guide must offer the two supported starting workspaces')
  await until('meeting choice saved', () => client.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).mode==='meeting'`))
  await client.key('ArrowLeft')
  await until('workspace radio keyboard selection', () => client.evaluate(`document.querySelector('.onboarding [role="radio"][aria-checked="true"]')?.textContent.includes('Interviews')`))
  assert.equal(await client.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).mode`), 'interview')
  report.checks.workspaceChoiceAndKeyboard = true
  await checkLayout(client, 1)
  await click(client, 'Continue')
  await step(client, 2)
  const progress = await client.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}))`)
  assert.equal(progress.step, 2, 'Progress must be saved before permissions')
  assert.equal(progress.completed, false)
  await client.send('Page.reload', { ignoreCache: true })
  await step(client, 2)
  report.checks.progressSurvivesReload = true
  await checkLayout(client, 2)
  await click(client, 'Refresh permissions')
  const permissions = await client.evaluate('window.faangin.getState()')
  assert.equal(permissions.capture.active, false, 'Permission refresh must never start capture')
  assert.equal(permissions.keyConfigured, false)
  const badges = await client.evaluate(`[...document.querySelectorAll('.onboarding-permission-status')].map(value=>value.textContent.trim())`)
  assert.deepEqual(badges, ['microphone', 'screen'].map(kind => permissions.permissions[kind] === 'granted' ? 'Allowed' : 'Not enabled'), 'Permission badges must reflect operating system status')
  report.permissions = permissions.permissions
  report.checks.permissionBadgesMatchSystem = true
  report.checks.permissionRefreshDoesNotRecord = true
  await click(client, 'Continue')
  await step(client, 3)
  await checkLayout(client, 3)
  await client.evaluate('window.faangin.updateSettings({theme:"light"})')
  await until('light appearance', () => client.evaluate(`!!document.querySelector('.theme-light')`))
  await client.screenshot('step-4-light-900x550.png')
  await click(client, 'Open workspace')
  await until('guide completion', () => client.evaluate(`!document.querySelector('.onboarding')`))
  assert.equal(await client.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).completed`), true)
  report.checks.completionSaved = true

  await client.evaluate('window.faangin.openWindow("workspace","settings")')
  await until('settings replay control', () => client.evaluate(`!!document.querySelector('[data-onboarding-replay]')`))
  await client.evaluate(`document.querySelector('[data-onboarding-replay]').click()`)
  await step(client, 0)
  report.checks.settingsReplay = true
  await until('explore first control', () => client.evaluate(`!!document.querySelector('.onboarding-footer [data-onboarding-skip]')`))
  await client.evaluate(`document.querySelector('.onboarding-footer [data-onboarding-skip]').click()`)
  await until('explicit skip', () => client.evaluate(`!document.querySelector('.onboarding')`))
  assert.equal(await client.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).completed`), true)
  report.checks.explicitSkipSavesCompletion = true

  await checkOverlay(running, client)

  client.close(); client = undefined
  await stop(running); running = undefined
  running = launch('ready-restart.json')
  await ready(running)
  client = await connect(running)
  await until('restarted workspace renderer', () => client.evaluate('!!document.querySelector(".app")'))
  assert.equal(await client.evaluate(`!!document.querySelector('.onboarding')`), false, 'Completed onboarding must remain dismissed after a full restart')
  assert.equal(await client.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).completed`), true)
  report.checks.completionSurvivesRestart = true

  await client.evaluate(`localStorage.setItem(${JSON.stringify(storageKey)}, '{invalid-json')`)
  await client.send('Page.reload', { ignoreCache: true })
  await step(client, 0)
  assert.equal((await client.evaluate('window.faangin.getState()')).capture.active, false)
  report.checks.invalidSavedProgressRecovers = true
  assert.deepEqual(report.rendererExceptions, [], 'Onboarding must not throw renderer exceptions')
  report.checks.noRendererExceptions = true
  report.passed = true
  await Promise.all(['failure.png', 'overlay-failure.png'].map(name => rm(join(output, name), { force: true })))
  console.log(`Desktop UX QA passed: four onboarding steps at 1000×650 and 900×550, keyboard focus and mode selection, fixture permission badges, saved progress, Settings replay, explicit skip, restart persistence, and malformed storage recovery; overlay in both themes at 480×560 and 360×550, keyboard More/Escape, transparent/readable material, and native 54px collapse. Screenshots: ${output}`)
} catch (error) {
  report.passed = false
  report.error = redact(error.stack || error.message)
  if (client) { try { await client.screenshot('failure.png') } catch {} }
  throw error
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  client?.close()
  await stop(running)
  await rm(fixture, { recursive: true, force: true })
}
