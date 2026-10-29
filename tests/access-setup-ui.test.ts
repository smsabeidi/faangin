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
function state(report: AccessSetupState): AppState {
  return { accessSetup: report, settings: DEFAULT_SETTINGS, permissions: { platform: 'darwin', microphone: report.permissions.microphone, screen: report.permissions.screen }, accessibility: { reduceMotion: false, reduceTransparency: false, increaseContrast: false }, keyConfigured: false, chatConfigured: false, compatibleKeyConfigured: false, sessions: [], currentSession: null, version: 'fixture', windowKind: 'workspace', capture: { active: false, sessionId: null, microphone: 'Off', system: 'Off' }, shortcuts: [] }
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
