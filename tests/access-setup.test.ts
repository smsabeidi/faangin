import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessSetupCoordinator, checkSystemAudioReadiness, setupAudioPermissionAllowed, setupAudioPermissionCheckAllowed, type AccessSetupReceipt } from '../src/main/access-setup'
import type { PermissionStatus } from '../src/shared/types'
import { Repository } from '../src/main/repository'

const allowed: PermissionStatus = { platform: 'darwin', microphone: 'granted', screen: 'granted' }

test('screen and microphone grants never stand in for the separate computer audio access check', () => {
  const coordinator = new AccessSetupCoordinator(undefined, () => {})
  assert.deepEqual(coordinator.snapshot(allowed), { required: true, completed: false, ready: false, checking: false, systemAudioVerifiedAt: null, permissions: { microphone: 'granted', screen: 'granted', systemAudio: 'not-requested' } })
  assert.throws(() => coordinator.complete(allowed), /verify computer audio/)
  assert.throws(() => coordinator.assertReady(allowed), /Finish access setup/)
})

test('completion persists consent and history, while a new process still needs a current audio check', () => {
  let saved: AccessSetupReceipt | undefined
  const coordinator = new AccessSetupCoordinator(undefined, value => { saved = value })
  coordinator.beginAudioCheck()
  assert.equal(coordinator.snapshot(allowed).checking, true)
  coordinator.finishAudioCheck(true)
  assert.equal(coordinator.snapshot(allowed).ready, true)
  assert.equal(coordinator.snapshot(allowed).required, true)
  coordinator.complete(allowed)
  assert.equal(coordinator.snapshot(allowed).required, false)
  assert.equal(saved?.completed, true)
  const restored = new AccessSetupCoordinator(saved, () => {})
  assert.equal(restored.snapshot(allowed).required, true)
  assert.equal(restored.snapshot(allowed).permissions.systemAudio, 'not-requested')
  assert.equal(restored.mayRecheckOnStartup(allowed), true)
  assert.equal(restored.mayRecheckOnStartup({ ...allowed, screen: 'denied' }), false)
  assert.ok(restored.snapshot(allowed).systemAudioVerifiedAt)
  restored.beginAudioCheck(); restored.finishAudioCheck(true)
  assert.equal(restored.snapshot(allowed).required, false)
})

test('revocation closes the gate without discarding completion or replacing the session repository', () => {
  const coordinator = new AccessSetupCoordinator({ version: 1, completed: true, systemAudioVerifiedAt: Date.now() }, () => {})
  coordinator.finishAudioCheck(true)
  for (const kind of ['microphone', 'screen'] as const) {
    const revoked = coordinator.snapshot({ ...allowed, [kind]: 'denied' })
    assert.equal(revoked.completed, true)
    assert.equal(revoked.required, true)
    assert.equal(revoked.ready, false)
  }
  coordinator.finishAudioCheck(false, 'Computer audio access was revoked.', true)
  assert.equal(coordinator.snapshot(allowed).permissions.systemAudio, 'denied')
  assert.equal(coordinator.snapshot(allowed).required, true)
  assert.equal(coordinator.snapshot(allowed).systemAudioVerifiedAt, null)
  assert.equal(coordinator.mayRecheckOnStartup(allowed), false)
})

test('invalid, future-dated and unavailable persistence never manufacture permission readiness', () => {
  for (const invalid of [undefined, {}, { version: 2, completed: true, systemAudioVerifiedAt: 1 }, { version: 1, completed: 'true', systemAudioVerifiedAt: 1 }, { version: 1, completed: true, systemAudioVerifiedAt: Date.now() + 100_000 }]) {
    assert.equal(new AccessSetupCoordinator(invalid, () => {}).snapshot(allowed).required, true)
  }
  const coordinator = new AccessSetupCoordinator(undefined, () => { throw new Error('Disk full') })
  coordinator.beginAudioCheck()
  assert.throws(() => coordinator.finishAudioCheck(true), /Disk full/)
  assert.equal(coordinator.snapshot(allowed).checking, false)
  assert.equal(coordinator.snapshot(allowed).ready, false)
  assert.equal(coordinator.snapshot(allowed).permissions.systemAudio, 'unavailable')
})

test('setup permission admission is limited to one trusted active display-audio lease, excluding microphone and camera requests', () => {
  for (const trusted of [false, true]) for (const active of [false, true]) {
    assert.equal(setupAudioPermissionAllowed(trusted, active, 'display-capture', undefined), trusted && active)
    assert.equal(setupAudioPermissionAllowed(trusted, active, 'media', []), trusted && active)
    assert.equal(setupAudioPermissionCheckAllowed(trusted, active, 'media', 'unknown'), trusted && active)
    for (const types of [['audio'], ['video'], ['audio', 'video'], undefined, null]) assert.equal(setupAudioPermissionAllowed(trusted, active, 'media', types), false)
    for (const permission of ['camera', 'microphone', 'notifications', 'geolocation']) assert.equal(setupAudioPermissionAllowed(trusted, active, permission, []), false)
    for (const mediaType of ['audio', 'video']) assert.equal(setupAudioPermissionCheckAllowed(trusted, active, 'media', mediaType), false)
  }
})

test('computer audio verification stops every track immediately and never consumes media samples', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let requests = 0, stops = 0
  const tracks = ['audio', 'video'].map(kind => ({ kind, readyState: 'live', stop() { stops++; this.readyState = 'ended' } }))
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getDisplayMedia: async (options: unknown) => {
    requests++; assert.deepEqual(options, { video: true, audio: true })
    return { getTracks: () => tracks, getAudioTracks: () => tracks.filter(track => track.kind === 'audio') }
  } } } })
  try {
    assert.deepEqual(await checkSystemAudioReadiness(), { verified: true, allTracksStopped: true })
    assert.equal(requests, 1); assert.equal(stops, 2)
    assert.ok(tracks.every(track => track.readyState === 'ended'))
  } finally { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator') }
})

test('denied computer audio and missing audio tracks cannot pass readiness and still clean up video', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const video = { readyState: 'live', stop() { this.readyState = 'ended' } }
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getDisplayMedia: async () => ({ getTracks: () => [video], getAudioTracks: () => [] }) } } })
    assert.deepEqual(await checkSystemAudioReadiness(), { verified: false, allTracksStopped: true, error: 'NoAudioTrack' })
    assert.equal(video.readyState, 'ended')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getDisplayMedia: async () => { const error = new Error('Denied'); error.name = 'NotAllowedError'; throw error } } } })
    assert.deepEqual(await checkSystemAudioReadiness(), { verified: false, allTracksStopped: true, error: 'NotAllowedError' })
  } finally { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else Reflect.deleteProperty(globalThis, 'navigator') }
})

test('access completion survives a real repository restart with history disabled without rewriting sessions or user preferences', () => {
  const directory = mkdtempSync(join(tmpdir(), 'faangin-access-receipt-')), path = join(directory, 'workspace.sqlite')
  let repository = new Repository(path)
  try {
    const settings = repository.settings()
    repository.saveSettings({ ...settings, historyEnabled: false, fontSize: 17 })
    const coordinator = new AccessSetupCoordinator(repository.configuration('access-setup'), value => repository.saveConfiguration('access-setup', value))
    coordinator.finishAudioCheck(true); coordinator.complete(allowed)
    assert.equal(repository.settings().fontSize, 17)
    assert.equal(repository.settings().historyEnabled, false)
    assert.deepEqual(repository.list(), [])
    repository.close(); repository = new Repository(path)
    const restored = new AccessSetupCoordinator(repository.configuration('access-setup'), value => repository.saveConfiguration('access-setup', value))
    assert.equal(restored.snapshot(allowed).completed, true)
    assert.equal(restored.snapshot(allowed).ready, false)
    assert.equal(restored.mayRecheckOnStartup(allowed), true)
    assert.equal(repository.settings().fontSize, 17)
    assert.equal(repository.settings().historyEnabled, false)
  } finally { repository.close(); rmSync(directory, { recursive: true, force: true }) }
})
