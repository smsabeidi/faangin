import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AccessSetupState, AppState } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import AccessSetup from '../src/renderer/src/AccessSetup'
import { accessSetupReady, nextAccessPermission, permissionBlocked, permissionNeedsSettings, permissionStatusLabel } from '../src/renderer/src/access-setup-state'

const missing: AccessSetupState = { required: true, completed: false, ready: false, checking: false, permissions: { screen: 'unknown', microphone: 'unknown', systemAudio: 'not-requested' }, systemAudioVerifiedAt: null }
const ready: AccessSetupState = { ...missing, ready: true, permissions: { screen: 'granted', microphone: 'granted', systemAudio: 'verified' }, systemAudioVerifiedAt: 123 }
function state(report: AccessSetupState, platform = 'darwin'): AppState {
  return { accessSetup: report, settings: DEFAULT_SETTINGS, permissions: { platform, microphone: report.permissions.microphone, screen: report.permissions.screen }, accessibility: { reduceMotion: false, reduceTransparency: false, increaseContrast: false }, keyConfigured: false, chatConfigured: false, compatibleKeyConfigured: false, sessions: [], currentSession: null, version: 'fixture', windowKind: 'workspace', capture: { active: false, sessionId: null, microphone: 'Off', system: 'Off' }, shortcuts: [] }
}
const render = (value: AppState) => renderToStaticMarkup(createElement(AccessSetup, { state: value, onRefresh: async () => {}, onComplete() {} }))

test('access readiness requires all three checks and an authoritative backend readiness result', () => {
  assert.equal(accessSetupReady(undefined), false)
  assert.equal(accessSetupReady(missing), false)
  assert.equal(accessSetupReady(ready), true)
  assert.equal(accessSetupReady({ ...ready, ready: false }), false)
  for (const microphone of ['unknown', 'denied', 'restricted', 'unexpected']) assert.equal(accessSetupReady({ ...ready, permissions: { ...ready.permissions, microphone } }), false)
  for (const systemAudio of ['not-requested', 'checking', 'denied', 'unavailable'] as const) assert.equal(accessSetupReady({ ...ready, permissions: { ...ready.permissions, systemAudio } }), false)
  assert.equal(accessSetupReady({ ...ready, permissions: { ...ready.permissions, microphone: 'not-required', screen: 'not-required' } }), true)
})

test('setup advances one required capability at a time with computer audio checked separately', () => {
  assert.equal(nextAccessPermission(missing), 'microphone')
  assert.equal(nextAccessPermission({ ...missing, permissions: { ...missing.permissions, microphone: 'granted' } }), 'screen')
  assert.equal(nextAccessPermission({ ...missing, permissions: { ...missing.permissions, microphone: 'granted', screen: 'granted' } }), 'system-audio')
  assert.equal(nextAccessPermission(ready), undefined)
})

test('audio capability failures never claim an independent OS permission was granted or denied', () => {
  assert.equal(permissionStatusLabel(ready, 'system-audio'), 'Access checked')
  assert.equal(permissionStatusLabel(ready, 'microphone'), 'Granted')
  const unavailable: AccessSetupState = { ...missing, permissions: { ...missing.permissions, systemAudio: 'unavailable' } }
  assert.equal(permissionBlocked(unavailable, 'system-audio'), true)
  assert.equal(permissionNeedsSettings(unavailable, 'system-audio'), false)
  assert.equal(permissionNeedsSettings({ ...unavailable, permissions: { ...unavailable.permissions, systemAudio: 'denied' } }, 'system-audio'), true)
  assert.equal(permissionStatusLabel(missing, 'screen', true), 'Checking')
})

test('first-run gate presents permission setup without a tour, a bypass or a screen-share hiding offer', () => {
  const html = render(state(missing))
  assert.match(html, /role="dialog" aria-modal="true"/)
  assert.match(html, /Set up access/)
  assert.doesNotMatch(html, />Continue<|Explore first|Set up later|Finish setup later/)
  for (const kind of ['screen', 'microphone', 'system-audio']) assert.match(html, new RegExp(`data-permission="${kind}"`))
  assert.match(html, /does not transcribe or save audio/)
  for (const report of [missing, ready, { ...missing, completed: true }]) assert.doesNotMatch(render(state(report)), /screen-share privacy|type="checkbox"/i)
  assert.match(render(state(ready)), />Continue</)
})

test('macOS setup keeps its System Settings guidance, restart caveat and three required checks', () => {
  const html = render(state({ ...missing, permissions: { ...missing.permissions, microphone: 'denied' } }))
  assert.match(html, /Allow screen and audio access once\. We’ll guide you through each step\./)
  assert.match(html, /0 of 3 ready/)
  assert.match(html, /Open <strong>System Settings → Privacy &amp; Security → Microphone<\/strong> and enable Faangin\. Return here when you’re done; we’ll check automatically\.  If macOS asks to quit and reopen Faangin, choose <strong>Quit &amp; Reopen<\/strong>\. Your setup will resume\./)
  assert.match(html, /Open System Settings</)
  const audio = render(state({ ...missing, permissions: { screen: 'granted', microphone: 'granted', systemAudio: 'denied' } }))
  assert.match(audio, /Screen &amp; System Audio Recording<\/strong> and enable Faangin/)
  assert.match(audio, /Open System Settings</)
  assert.match(audio, /Retry audio check/)
})

test('Windows setup never presents screen recording as a permission and keeps computer audio a device check', () => {
  const windows: AccessSetupState = { ...missing, permissions: { screen: 'not-required', microphone: 'not-determined', systemAudio: 'not-requested' } }
  const html = render(state(windows, 'win32'))
  assert.match(html, /Allow microphone access once and let us check computer audio\. We’ll guide you through each step\./)
  assert.match(html, /0 of 2 ready/)
  assert.match(html, /data-permission="screen".*?Not required on this device/)
  assert.match(html, /aria-label="Screen capture access ready" disabled=""/)
  assert.match(html, /aria-label="Allow access to microphone"/)
  assert.match(html, /aria-label="Allow access to computer audio"/)
  assert.doesNotMatch(html, /Allow access to screen|Open settings for screen|System Settings|Screen &amp; System Audio Recording|macOS|Quit &amp; Reopen/)
  const microphoneDenied = render(state({ ...windows, permissions: { ...windows.permissions, microphone: 'denied' } }, 'win32'))
  assert.match(microphoneDenied, /Open <strong>Settings → Privacy &amp; security → Microphone<\/strong> and turn on both Microphone access and Let desktop apps access your microphone\. Return here when you’re done; we’ll check automatically\./)
  assert.match(microphoneDenied, /aria-label="Open settings for microphone"/)
  assert.match(microphoneDenied, /Open Windows Settings</)
  assert.doesNotMatch(microphoneDenied, /System Settings|macOS|Quit &amp; Reopen|privacy settings|restart/)
  const audioDenied = render(state({ ...windows, permissions: { ...windows.permissions, microphone: 'granted', systemAudio: 'denied' } }, 'win32'))
  assert.match(audioDenied, /Computer audio is captured from your default playback device\. Open Settings → System → Sound and choose the speakers or headset you listen on as the output device, and make sure it is not in exclusive mode\. Then choose Retry audio check below/)
  assert.match(audioDenied, /aria-label="Open settings for computer audio"/)
  assert.equal(audioDenied.match(/Open Windows Settings</g)?.length, 1, 'the help box offers the Sound page the main process deep-links to')
  assert.match(audioDenied, /Retry audio check</)
  assert.doesNotMatch(audioDenied, /System Settings|access for Faangin|privacy settings|Screen &amp; System Audio Recording/)
  const audioUnavailable = render(state({ ...windows, permissions: { ...windows.permissions, microphone: 'granted', systemAudio: 'unavailable' } }, 'win32'))
  assert.match(audioUnavailable, /aria-label="Retry access to computer audio"/)
  assert.doesNotMatch(audioUnavailable, /Open settings for computer audio/)
})
