/** Black-box native interaction regression. Owned disposable profile, no live services or recording. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'

const configuredApp = process.env.FAANGIN_APP_PATH
const selfProject = dirname(dirname(fileURLToPath(import.meta.url)))
const inferredProject = existsSync(join(selfProject,'package.json')) && existsSync(join(selfProject,'out/main/index.js')) ? selfProject : undefined
const explicitProject = process.env.FAANGIN_QA_SOURCE_ROOT || process.env.FAANGIN_PROJECT_ROOT
if (configuredApp && explicitProject) throw new Error('Choose either FAANGIN_APP_PATH or a source project root, not both.')
const sourceRoot = configuredApp ? undefined : explicitProject || inferredProject
let sourceElectron = process.env.FAANGIN_QA_ELECTRON
if (sourceRoot && !sourceElectron) {
  try { sourceElectron = createRequire(join(sourceRoot,'package.json'))('electron') }
  catch { throw new Error('Set FAANGIN_QA_ELECTRON to the installed Electron executable for an extracted app without dev dependencies.') }
}
const application = sourceRoot || configuredApp || '/Applications/Faangin.app'
const executable = sourceRoot ? sourceElectron : application.endsWith('.app') ? join(application,'Contents/MacOS/Faangin') : application
const fixture = await mkdtemp(join(tmpdir(), 'faangin-overlay-interaction-v033-'))
const output = process.env.FAANGIN_INTERACTION_QA_REPORT || '/private/tmp/faangin-overlay-interaction-v033-report.json'
const imagesDirectory = process.env.FAANGIN_INTERACTION_QA_IMAGES || join(dirname(output), 'screenshots-'+basename(output,'.json'))
const env = { ...process.env, FAANGIN_SMOKE: '1', FAANGIN_USER_DATA_DIR: fixture, FAANGIN_SMOKE_READY: join(fixture, 'ready.json'), FAANGIN_SMOKE_LIVE_FIXTURE: '1', FAANGIN_SMOKE_CAPTURE_FIXTURE: '1', FAANGIN_SMOKE_ACCESS_FIXTURE: 'ready' }
for (const name of Object.keys(env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(name)) delete env[name]
for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'FAANGIN_QA_VISIBLE', 'FAANGIN_SMOKE_NATIVE_AUDIO', 'FAANGIN_SMOKE_DOCUMENT_FIXTURES_DIR']) delete env[name]
const requests = [], sockets = new Set()
const provider = createServer((request, response) => {
  let raw = ''
  request.on('data', chunk => { raw += chunk })
  request.on('end', () => {
    let body, source, content
    try { body = JSON.parse(raw); content = body.messages.at(-1).content; source = JSON.parse(Array.isArray(content) ? content.find(p=>p.type==='text').text : content) } catch { response.writeHead(400); response.end(); return }
    if (request.method!=='POST' || request.headers.authorization || !body.stream || !['fixture-fast','fixture-smart'].includes(body.model)) { response.writeHead(400); response.end(); return }
    const item = { route: request.url, action: source.action, selectedIds: source.selectedImages?.map(i=>i.id)||[], imageParts: Array.isArray(content)?content.filter(p=>p.type==='image_url').length:0, cancelled: false }
    requests.push(item)
    if(request.url==='/quota') { response.writeHead(429,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{code:'insufficient_quota',message:'PRIVATE_FIXTURE_ERROR_TEXT'}}));return }
    response.writeHead(200,{'Content-Type':'text/event-stream'})
    const id = 'fixture-'+requests.length
    const frame = text => response.write(`data: ${JSON.stringify({id,model:body.model,choices:[{index:0,delta:{content:text},finish_reason:null}]})}\n\n`)
    frame('PUBLIC FIXTURE: Use breadth-first search. ')
    const timer = setTimeout(()=>{frame('A queue explores the unweighted graph by distance.');response.write(`data: ${JSON.stringify({id,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);response.end()},request.url==='/slow'?7000:80)
    response.once('close',()=>{clearTimeout(timer);item.cancelled=!response.writableEnded})
  })
})
provider.on('connection', socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))})
provider.listen(0,'127.0.0.1');await once(provider,'listening')
const endpoint = 'http://127.0.0.1:'+provider.address().port+'/chat/completions'
const child = spawn(executable, [...(sourceRoot ? [sourceRoot] : []), '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { cwd: fixture, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = '', ended, spawnError, workspace, overlay
child.stdout.on('data', bytes => { logs = (logs + bytes).slice(-12000) }); child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-12000) })
child.on('exit', code => { ended = code ?? -1 }); child.on('error', error => { spawnError = error })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { application, checks: {}, scope: 'Native BrowserWindow API state and owned renderer DOM/CDP events. Controlled localhost fixture responses only. No OS pointer hit-testing, global shortcut delivery, live provider, desktop pixels or recording.', physicalPointerRoutingVerified: false, physicalShortcutDeliveryVerified: false, manualAcceptanceRemaining: ['macOS pointer hit-testing and physical dragging','physical global shortcut delivery','native image import file picker','system clipboard Copy behavior','live screen capture and audio resume','recorder-specific content protection'] }
async function until(label, fn, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(30) }
  throw new Error('Timed out waiting for ' + label)
}
async function targets() {
  let port = logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]
  if (!port) { try { port = (await readFile(join(fixture, 'DevToolsActivePort'), 'utf8')).split('\n')[0] } catch {} }
  if (!/^\d+$/.test(port || '')) return []
  return fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json()).catch(() => [])
}
async function connect(kind) {
  const target = await until(kind + ' debugger', async () => (await targets()).find(t => t.type === 'page' && new URL(t.url).searchParams.get('window') === kind))
  const url = new URL(target.webSocketDebuggerUrl)
  assert.equal(url.protocol, 'ws:'); assert.equal(url.hostname, '127.0.0.1')
  const socket = new WebSocket(url.href)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('Debugger connection failed')), { once: true }) })
  let sequence = 0; const pending = new Map()
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data), job = pending.get(value.id)
    if (!job) return; pending.delete(value.id); clearTimeout(job.timer)
    value.error ? job.reject(new Error(value.error.message)) : job.resolve(value.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')) }, 15000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  return { send, close: () => socket.close(), async evaluate(expression) { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description); return result.result.value } }
}
const hasButton = label => overlay.evaluate(`Array.from(document.querySelectorAll('button')).some(e=>e.getAttribute('aria-label')===${JSON.stringify(label)})`)
const clickButton = label => overlay.evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}).click()`)
async function nativeState(client) { return client.evaluate('window.faanginSmoke.liveFixture({type:"overlay-state"})') }
async function assertNative(client, expected) {
  const state = await nativeState(client)
  assert.equal(state.passive, expected.passive, 'Native policy passive flag')
  assert.equal(state.focusable, expected.focusable, 'Actual BrowserWindow.isFocusable()')
  if ('visible' in expected) assert.equal(state.visible, expected.visible, 'Actual BrowserWindow visibility')
  return state
}
try {
  await until('desktop startup', async () => {
    if (spawnError) throw spawnError
    if (ended !== undefined) throw new Error('Isolated app exited: ' + ended)
    try { const marker = JSON.parse(await readFile(env.FAANGIN_SMOKE_READY, 'utf8')); if (marker.error) throw new Error(marker.error); return marker } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
  }, 35000)
  workspace = await connect('workspace')
  const initial = await workspace.evaluate('window.faangin.getState()')
  report.version = initial.version; report.initialPassThrough = initial.overlayClickThrough
  assert.equal(initial.keyConfigured, false, 'Disposable profile must have no provider credential')
  assert.equal(initial.capture.active, false)
  assert.equal(initial.overlayClickThrough, false, 'Fresh overlay must be interactive; native click-through cannot be the default while controls are visible')
  report.checks.freshDefaultInteractive = true
  await workspace.evaluate('window.faangin.openWindow("overlay")')
  overlay = await connect('overlay')
  await until('overlay renderer', () => overlay.evaluate('!!document.querySelector(".overlay-topbar")'))
  assert.equal((await overlay.evaluate('window.faangin.getState()')).overlayClickThrough, false)
  report.firstOpenNative = await assertNative(overlay, { passive: false, focusable: true })
  report.checks.firstOpenNativeFocusable = true
  const controls = await overlay.evaluate('(() => [...document.querySelectorAll(".overlay-topbar button,.overlay-topbar summary,.composer textarea")].filter(e=>e.getBoundingClientRect().width>0).map(e=>({label:e.getAttribute("aria-label")||e.textContent.trim(),drag:getComputedStyle(e).webkitAppRegion,cursor:getComputedStyle(e).cursor})))()')
  assert.ok(controls.length >= 3)
  for (const control of controls) assert.equal(control.drag, 'no-drag', control.label + ' must receive its own mouse events')
  report.headerControls = controls; report.checks.controlsOutsideDragRegion = true
  await overlay.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await overlay.evaluate('document.querySelector(".overlay-more>summary").focus()')
  await overlay.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await overlay.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until('keyboard More opening', () => overlay.evaluate('document.querySelector(".overlay-more").open'))
  await overlay.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await overlay.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until('Escape closes More', () => overlay.evaluate('!document.querySelector(".overlay-more").open'))
  assert.equal(await overlay.evaluate('document.activeElement===document.querySelector(".overlay-more>summary")'), true)
  report.checks.moreKeyboardAndEscape = true
  await overlay.evaluate('window.faangin.setClickThrough(true)')
  report.optedInNative = await assertNative(overlay, { passive: true, focusable: false })
  report.checks.explicitPassiveOptIn = true
  await overlay.evaluate('window.faangin.hideOverlay()')
  await workspace.evaluate('window.faangin.openWindow("overlay")')
  await until('explicit reopen interactive', async () => !(await overlay.evaluate('window.faangin.getState()')).overlayClickThrough)
  report.reopenedNative = await assertNative(overlay, { passive: false, focusable: true })
  report.checks.explicitReopenRecoversInteraction = true
  await overlay.evaluate('window.faangin.updateSettings({overlayCollapsed:true})')
  await until('collapsed header', () => hasButton('Expand overlay'))
  await clickButton('Expand overlay')
  await until('expanded via header', () => hasButton('Collapse overlay'))
  report.checks.collapseExpandHeader = true
  await overlay.evaluate('document.querySelector(".overlay-more>summary").click()')
  const smart = await overlay.evaluate('(async()=>{const before=(await window.faangin.getState()).settings.smartMode; [...document.querySelectorAll(".overlay-more-panel button")].find(e=>e.textContent.includes("Smart answers")).click(); return before})()')
  await until('Smart toggle', async () => (await overlay.evaluate('window.faangin.getState()')).settings.smartMode !== smart)
  report.checks.smartToggle = true
  await overlay.evaluate('window.faangin.hideOverlay()')
  await workspace.evaluate('window.faangin.openWindow("overlay")')
  assert.equal((await overlay.evaluate('window.faangin.getState()')).overlayClickThrough, false)
  report.checks.hideAndReopen = true
  // Listening setup must reveal consent instead of starting capture on first click.
  await overlay.evaluate('document.querySelector(".overlay-listen-button").click()')
  await until('listening setup panel',()=>overlay.evaluate('document.querySelector(".overlay-more").open'))
  assert.equal(await overlay.evaluate('!!document.querySelector(".overlay-more-panel .hands-free-consent")'),true)
  assert.equal((await overlay.evaluate('window.faangin.getState()')).capture.active,false)
  report.checks.listeningSetupDoesNotRecord = true
  await overlay.evaluate('window.faangin.updateSettings({chatProvider:"compatible",compatibleChatEndpoint:'+JSON.stringify(endpoint)+',compatibleChatModel:"fixture-fast",compatibleChatSmartModel:"fixture-smart",compatibleChatVision:true,smartMode:false,liveSuggestions:false})')
  const session = await overlay.evaluate('window.faangin.createSession("interview")')
  const manual = await overlay.evaluate('window.faanginSmoke.liveFixture({type:"image",sessionId:'+JSON.stringify(session.id)+'})')
  await overlay.evaluate('window.faangin.selectAttachments('+JSON.stringify(session.id)+',['+JSON.stringify(manual.id)+'])')
  const latest = async()=> (await overlay.evaluate('window.faangin.getState()')).currentSession.answers.at(-1)
  let previous
  async function captureFromHeader() {
    previous = (await latest())?.requestId
    await clickButton('Capture & solve')
    return until('fresh header answer',async()=>{const a=await latest();return a && a.requestId!==previous && a.status==='complete'?a:false})
  }
  const first = await captureFromHeader()
  assert.equal(first.context.attachmentIds.length,1)
  assert.notEqual(first.context.attachmentIds[0],manual.id)
  assert.equal(requests.at(-1).imageParts,1)
  assert.deepEqual(requests.at(-1).selectedIds,first.context.attachmentIds)
  report.checks.headerCaptureFreshImageOnly = true
  await mkdir(imagesDirectory,{recursive:true})
  report.screenshots=[];report.geometry=[]
  for(const theme of ['dark','light'])for(const [width,height] of [[480,700],[360,550]]){
    await overlay.evaluate('window.faangin.updateSettings({theme:'+JSON.stringify(theme)+',opacity:1})')
    await overlay.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
    await delay(60)
    const geometry = await overlay.evaluate('(()=>{const h=document.querySelector(".overlay-topbar"),i=document.querySelector(".overlay-identity"),rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};return{width:innerWidth,height:innerHeight,pageWidth:document.body.scrollWidth,headerDrag:getComputedStyle(h).webkitAppRegion,identity:rect(i),identityDrag:getComputedStyle(i).webkitAppRegion,controls:[...h.querySelectorAll("button,summary")].filter(e=>e.getBoundingClientRect().width>0&&e.closest(".overlay-more-panel")===null).map(e=>({label:e.getAttribute("aria-label")||e.textContent.trim(),...rect(e),drag:getComputedStyle(e).webkitAppRegion}))}})()')
    assert.ok(geometry.pageWidth<=width+1,'No horizontal overflow')
    assert.equal(geometry.headerDrag,'no-drag')
    assert.equal(geometry.identityDrag,'drag')
    assert.ok(geometry.identity.width<=111,'Drag handle is bounded, not whole toolbar')
    for(const control of geometry.controls){assert.equal(control.drag,'no-drag');assert.ok(control.x>=geometry.identity.right-1,'Control cannot overlap drag handle');assert.ok(control.right<=width+1)}
    report.geometry.push({theme,...geometry})
    const screenshot=await overlay.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
    const image=join(imagesDirectory,theme+'-'+width+'x'+height+'.png');await writeFile(image,Buffer.from(screenshot.data,'base64'));report.screenshots.push(image)
  }
  await overlay.send('Emulation.setDeviceMetricsOverride',{width:480,height:700,deviceScaleFactor:1,mobile:false})
  report.checks.boundedLogoDragAndResponsiveControls = true
  // Preview is synthetic and cancellation must not add or select another image.
  const beforeRegion = await overlay.evaluate('(async()=>{const s=await window.faangin.getState();return{count:s.currentSession.attachments.length,selection:s.currentSession.selectedAttachmentIds}})()')
  await overlay.evaluate('document.querySelector(".overlay-more").open=true')
  await overlay.evaluate('[...document.querySelectorAll(".overlay-more-panel button")].find(e=>e.textContent.includes("Capture a region")).click()')
  await until('synthetic region preview',()=>overlay.evaluate('!!document.querySelector(".region-capture")'))
  await overlay.evaluate('[...document.querySelectorAll(".modal-actions button")].find(e=>e.textContent.trim()==="Cancel").click()')
  await until('region preview cancelled',()=>overlay.evaluate('!document.querySelector(".region-capture")'))
  const afterRegion = await overlay.evaluate('(async()=>{const s=await window.faangin.getState();return{count:s.currentSession.attachments.length,selection:s.currentSession.selectedAttachmentIds}})()')
  assert.deepEqual(afterRegion,beforeRegion)
  report.checks.regionPreviewCancelRetainsSelection = true
  await until('screenshot count chip',()=>overlay.evaluate('document.querySelector(".attachment-collapsed-summary")?.textContent.includes("1 screenshot selected")'))
  await overlay.evaluate('document.querySelector(".attachment-collapsed-summary").click()')
  await until('explicit screenshot review',()=>overlay.evaluate('!!document.querySelector(".attachment-tray")'))
  assert.equal(await overlay.evaluate('document.querySelectorAll(".attachment-select input:checked").length'),1)
  await overlay.evaluate('[...document.querySelectorAll(".composer button")].find(e=>e.textContent.includes("Collapse screenshots")).click()')
  await until('screenshot controls collapse',()=>overlay.evaluate('!document.querySelector(".attachment-tray")'))
  report.checks.screenshotDisclosureAndSelection = true
  for(let i=0;i<5;i++) {
    const answer = await captureFromHeader(), state = await overlay.evaluate('window.faangin.getState()')
    assert.equal(answer.context.attachmentIds.length,1)
    assert.ok(state.currentSession.attachments.length<=4)
    assert.ok(state.currentSession.attachments.some(i=>i.id===manual.id))
    assert.deepEqual(state.currentSession.selectedAttachmentIds,answer.context.attachmentIds)
    assert.equal(await overlay.evaluate('!!document.querySelector(".attachment-tray")'),false)
  }
  report.checks.repeatedCapturesPreserveManualReferences = true
  const draft='Keep this public follow-up draft'
  await overlay.evaluate('(()=>{const e=document.querySelector(".composer textarea"),set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(e,'+JSON.stringify(draft)+');e.dispatchEvent(new Event("input",{bubbles:true}))})()')
  await overlay.evaluate('window.faangin.updateSettings({compatibleChatEndpoint:'+JSON.stringify(endpoint.replace('/chat/completions','/slow'))+'})')
  previous=(await latest()).requestId
  await clickButton('Capture & solve')
  const streaming=await until('streaming header answer',async()=>{const a=await latest();return a&&a.requestId!==previous&&a.status==='streaming'&&a.text?a:false})
  const requestCount=requests.length
  const duplicated=await overlay.evaluate('Promise.all([window.faangin.captureAndSolve('+JSON.stringify(session.id)+'),window.faangin.captureAndSolve('+JSON.stringify(session.id)+')])')
  assert.equal(duplicated[0].requestId,streaming.requestId);assert.equal(duplicated[1].requestId,streaming.requestId);assert.equal(requests.length,requestCount)
  await until('Stop answer header control', () => hasButton('Stop answer'))
  await clickButton('Stop answer')
  const cancelled=await until('cancelled partial retained',async()=>{const a=await latest();return a?.requestId===streaming.requestId&&a.status==='cancelled'?a:false})
  assert.ok(cancelled.text.includes('PUBLIC FIXTURE'))
  assert.equal(await overlay.evaluate('document.querySelector(".composer textarea").value'),draft)
  report.checks.duplicateCoalescingAndHeaderCancellation = true
  await overlay.evaluate('window.faangin.updateSettings({compatibleChatEndpoint:'+JSON.stringify(endpoint.replace('/chat/completions','/quota'))+'})')
  previous=(await latest()).requestId
  await clickButton('Capture & solve')
  await until('safe provider failure',async()=>{const a=await latest();return a&&a.requestId!==previous&&a.status==='failed'})
  assert.equal(await overlay.evaluate('document.body.textContent.includes("PRIVATE_FIXTURE_ERROR_TEXT")'),false)
  report.checks.safeCaptureSolveFailure = true
  await overlay.evaluate('window.faangin.updateSettings({compatibleChatEndpoint:'+JSON.stringify(endpoint)+'})')
  await overlay.evaluate('(()=>{const e=document.querySelector(".composer textarea"),set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(e,"");e.dispatchEvent(new Event("input",{bubbles:true}))})()')
  await overlay.evaluate('window.faangin.appendTranscript('+JSON.stringify(session.id)+',"Why use BFS instead of DFS for this unweighted graph?")')
  await overlay.evaluate('document.querySelector(".overlay-more").open=true')
  await until('enabled follow-up in More',()=>overlay.evaluate('[...document.querySelectorAll(".overlay-more-panel button")].some(e=>/Answer latest|Answer follow-up/.test(e.textContent)&&!e.disabled)'))
  previous=(await latest()).requestId
  await overlay.evaluate('[...document.querySelectorAll(".overlay-more-panel button")].find(e=>/Answer latest|Answer follow-up/.test(e.textContent)).click()')
  const followup=await until('More follow-up answer',async()=>{const a=await latest();return a&&a.requestId!==previous&&a.status==='complete'?a:false})
  assert.equal(followup.action,'reply')
  assert.equal(followup.context.attachmentIds.length,0)
  assert.equal(requests.at(-1).action,'reply')
  assert.equal(requests.at(-1).imageParts,0)
  report.checks.moreFollowupUsesConversationWithoutResendingImage = true
  // No real audio stream: startFixtureCapture creates owned synthetic sources only.
  await overlay.evaluate('window.faangin.updateSettings({liveSuggestions:false,microphone:true,systemAudio:true})')
  await overlay.evaluate('window.faanginSmoke.liveFixture({type:"start",sessionId:'+JSON.stringify(session.id)+'})')
  await until('synthetic listening state',async()=> (await overlay.evaluate('window.faangin.getState()')).capture.active)
  await overlay.evaluate('document.querySelector(".overlay-more").open=true')
  await overlay.evaluate('[...document.querySelectorAll(".overlay-more-panel button")].find(e=>e.textContent.includes("Pause listening")).click()')
  await until('fixture paused',async()=>{const s=await overlay.evaluate('window.faangin.getState()');return s.capture.microphone==='Paused'||s.capture.system==='Paused'})
  await overlay.evaluate('[...document.querySelectorAll(".overlay-more-panel button")].find(e=>e.textContent.includes("Resume listening")).click()')
  await until('Resume reports missing credential safely',()=>overlay.evaluate('/OpenAI.*key|key.*Settings|Settings.*key/i.test(document.querySelector(".banner.error,.banner-error")?.textContent||document.body.textContent)'))
  assert.equal((await overlay.evaluate('window.faangin.getState()')).capture.active,false)
  report.checks.resumeCredentialGuardWithoutRecording = true
  await overlay.evaluate('window.faangin.stopCapture()')
  await overlay.evaluate('window.faanginSmoke.liveFixture({type:"start",sessionId:'+JSON.stringify(session.id)+'})')
  await until('fresh synthetic listening state',async()=> (await overlay.evaluate('window.faangin.getState()')).capture.active)
  await clickButton('Stop listening')
  await until('fixture stopped',async()=> !(await overlay.evaluate('window.faangin.getState()')).capture.active)
  report.checks.syntheticListeningPauseAndHeaderStop = true
  await overlay.evaluate('document.querySelector(".overlay-more").open=true')
  await overlay.evaluate('[...document.querySelectorAll(".overlay-more-panel button")].find(e=>e.textContent.includes("Audio, shortcuts & settings")).click()')
  await until('workspace Settings navigation',()=>workspace.evaluate('[...document.querySelectorAll("h1,h2")].some(e=>e.textContent.trim()==="Settings")'))
  report.checks.settingsNavigation = true
  await workspace.evaluate('[...document.querySelectorAll("nav button")].find(e=>e.textContent.trim()==="Workspace").click()')
  await until('workspace view before overlay Settings shortcut',()=>workspace.evaluate('!!document.querySelector(".workspace-main")'))
  await overlay.send('Emulation.setFocusEmulationEnabled',{enabled:true})
  await overlay.send('Input.dispatchKeyEvent',{type:'keyDown',key:',',code:'Comma',windowsVirtualKeyCode:188,modifiers:4})
  await overlay.send('Input.dispatchKeyEvent',{type:'keyUp',key:',',code:'Comma',windowsVirtualKeyCode:188,modifiers:4})
  await until('overlay Command comma routes workspace Settings',()=>workspace.evaluate('[...document.querySelectorAll("h1,h2")].some(e=>e.textContent.trim()==="Settings")'))
  report.checks.overlaySettingsShortcutRoutesWorkspace = true
  report.requests = requests
  report.passed = true
  console.log('Faangin ' + report.version + ': default/native interaction regression passed; no manual setClickThrough(false) recovery used.')
} catch (error) {
  report.passed = false; report.error = String(error.message || error)
  report.requests = requests
  if(overlay)try{report.failureState=await overlay.evaluate('(async()=>{const s=await window.faangin.getState();return{captureSolve:s.captureSolve,lastAnswer:s.currentSession?.answers.at(-1),alerts:[...document.querySelectorAll("[role=alert],.banner")].map(e=>e.textContent),captureButton:{disabled:document.querySelector(".overlay-capture-button")?.disabled,label:document.querySelector(".overlay-capture-button")?.textContent},modal:!!document.querySelector(".region-capture")}})()')}catch{}
  console.error(report.error); process.exitCode = 1
} finally {
  workspace?.close(); overlay?.close()
  if (child.pid && ended === undefined) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(2000)])
    if (ended === undefined) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
  }
  for(const socket of sockets)socket.destroy()
  await new Promise(resolve=>provider.close(resolve))
  await writeFile(output, JSON.stringify(report, null, 2)+'\n')
  await rm(fixture, { recursive: true, force: true })
}
