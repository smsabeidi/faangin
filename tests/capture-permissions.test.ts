import assert from 'node:assert/strict'
import test from 'node:test'
import { capturePermissionCheckAllowed, capturePermissionRequestAllowed, displayMediaResponse, type CapturePermissionScope } from '../src/main/capture-permissions'

const capture: CapturePermissionScope = { trustedCaptureMainFrame: true, activeSystemAudio: true }
const microphoneOnly: CapturePermissionScope = { trustedCaptureMainFrame: true, activeSystemAudio: false }
const untrusted: CapturePermissionScope = { trustedCaptureMainFrame: false, activeSystemAudio: true }

test('Electron 44 empty mediaTypes display request is admitted only by its active system capture owner', () => {
  // Pinned Electron 44 RequestMediaAccessPermission adds types only for DEVICE_* inputs.
  // Its DISPLAY_* request reaches the JS handler as permission='media', mediaTypes=[].
  assert.equal(capturePermissionRequestAllowed(capture, 'media', []), true)
  assert.equal(capturePermissionRequestAllowed(microphoneOnly, 'media', []), false)
  assert.equal(capturePermissionRequestAllowed(untrusted, 'media', []), false)
})

test('owned microphone requests remain available without enabling system audio', () => {
  assert.equal(capturePermissionRequestAllowed(microphoneOnly, 'media', ['audio']), true)
  assert.equal(capturePermissionCheckAllowed(microphoneOnly, 'media', 'audio'), true)
})

test('the modern display-capture permission uses the same explicit system-audio ownership gate', () => {
  for (const types of [undefined, [], ['video'], ['audio', 'video']]) {
    assert.equal(capturePermissionRequestAllowed(capture, 'display-capture', types), true)
    assert.equal(capturePermissionRequestAllowed(microphoneOnly, 'display-capture', types), false)
    assert.equal(capturePermissionRequestAllowed(untrusted, 'display-capture', types), false)
  }
  assert.equal(capturePermissionCheckAllowed(capture, 'display-capture', 'video'), true)
  assert.equal(capturePermissionCheckAllowed(microphoneOnly, 'display-capture', 'video'), false)
})

test('camera or mixed camera/microphone requests stay denied during system capture', () => {
  for (const types of [['video'], ['audio', 'video'], ['video', 'audio'], ['audio', 'audio'], ['unknown']]) {
    assert.equal(capturePermissionRequestAllowed(capture, 'media', types), false)
    assert.equal(capturePermissionRequestAllowed(microphoneOnly, 'media', types), false)
  }
  assert.equal(capturePermissionCheckAllowed(capture, 'media', 'video'), false)
})

test('unknown desktop-media checks need current system capture ownership and reject malformed values', () => {
  for (const type of ['unknown', undefined]) {
    assert.equal(capturePermissionCheckAllowed(capture, 'media', type), true)
    assert.equal(capturePermissionCheckAllowed(microphoneOnly, 'media', type), false)
    assert.equal(capturePermissionCheckAllowed(untrusted, 'media', type), false)
  }
  for (const type of [null, '', 'desktop', {}, ['audio']]) assert.equal(capturePermissionCheckAllowed(capture, 'media', type), false)
})

test('missing or malformed request arrays cannot masquerade as the explicit legacy display request', () => {
  for (const types of [undefined, null, 'audio', {}, { length: 0 }, [null]]) {
    assert.equal(capturePermissionRequestAllowed(capture, 'media', types), false)
  }
})

test('UI, foreign pages and subframes represented by an untrusted scope receive no capture permissions', () => {
  for (const permission of ['media', 'display-capture']) {
    for (const types of [[], ['audio'], ['video']]) assert.equal(capturePermissionRequestAllowed(untrusted, permission, types), false)
    for (const type of [undefined, 'audio', 'video', 'unknown']) assert.equal(capturePermissionCheckAllowed(untrusted, permission, type), false)
  }
  for (const permission of ['clipboard-read', 'usb', 'camera', 'geolocation', 'unknown']) {
    assert.equal(capturePermissionRequestAllowed(capture, permission, []), false)
    assert.equal(capturePermissionCheckAllowed(capture, permission, 'audio'), false)
  }
})

test('stopping, disabling or revoking system capture closes legacy and modern admission on the next check', () => {
  const scope = { ...capture }
  assert.equal(capturePermissionRequestAllowed(scope, 'media', []), true)
  scope.activeSystemAudio = false
  assert.equal(capturePermissionRequestAllowed(scope, 'media', []), false)
  assert.equal(capturePermissionRequestAllowed(scope, 'display-capture', ['video', 'audio']), false)
  assert.equal(capturePermissionCheckAllowed(scope, 'media', 'unknown'), false)
})

test('an owned loopback request is answered with the primary screen and loopback audio on both desktop platforms', () => {
  const primary = { id: 'screen:0:0', display_id: '2528732444' }, secondary = { id: 'screen:1:0', display_id: '1234567890' }
  for (const platform of ['darwin', 'win32'] as const) {
    assert.deepEqual(displayMediaResponse([secondary, primary], '2528732444', platform, true), { video: primary, audio: 'loopback' })
    assert.deepEqual(displayMediaResponse([secondary, primary], '2528732444', platform, false), {}, 'a lapsed lease or generation declines without a source')
    assert.deepEqual(displayMediaResponse([], '2528732444', platform, true), {})
  }
})

test('only Windows admits a loopback request through a screen whose display_id cannot be matched', () => {
  // Duplicated and remote displays report an empty display_id on Windows; loopback audio is device-wide so any screen admits it there.
  const duplicated = { id: 'screen:0:0', display_id: '' }
  assert.deepEqual(displayMediaResponse([duplicated], '2528732444', 'win32', true), { video: duplicated, audio: 'loopback' })
  assert.deepEqual(displayMediaResponse([duplicated], '2528732444', 'darwin', true), {})
  assert.deepEqual(displayMediaResponse([duplicated], '2528732444', 'linux', true), {})
  assert.deepEqual(displayMediaResponse([duplicated], '2528732444', 'win32', false), {})
})
