import assert from 'node:assert/strict'
import test from 'node:test'
import { validateMicrophoneInventory } from '../src/main/microphone-inventory'
import { refreshMicrophoneDevices, microphoneChoices } from '../src/renderer/src/microphone-devices'

test('the capture inventory exposes only bounded IDs and sanitized labels', () => {
  assert.deepEqual(validateMicrophoneInventory([{ deviceId: 'input', label: 'Studio\nMicrophone', groupId: 'PRIVATE_GROUP', other: 'PRIVATE' }]), [{ deviceId: 'input', label: 'Studio Microphone' }])
  for (const value of [null, {}, Array.from({ length: 65 }, (_, index) => ({ deviceId: String(index), label: '' })), [{ deviceId: '', label: '' }], [{ deviceId: 'input', label: 'x'.repeat(161) }], [{ deviceId: 'input', label: '' }, { deviceId: 'input', label: '' }]]) assert.throws(() => validateMicrophoneInventory(value), /inventory/)
})

test('a missing saved microphone stays explicit and discovery never substitutes the default', async () => {
  const snapshot = await refreshMicrophoneDevices(async () => [{ deviceId: 'available', label: '' }])
  const choices = microphoneChoices(snapshot, 'unplugged')
  assert.equal(choices[0].value, ''); assert.equal(choices.at(-1)?.value, 'unplugged'); assert.equal(choices.at(-1)?.availability, 'unavailable')
  assert.equal(snapshot.labelsRestricted, true)
  assert.equal(microphoneChoices(snapshot, 'available').filter(choice => choice.value === 'available').length, 1)
})

test('discovery timeout and cancellation fence late inventories and hide raw failures', async () => {
  let finish!: (devices: Array<{ deviceId: string; label: string }>) => void
  const pending = new Promise<Array<{ deviceId: string; label: string }>>(resolve => { finish = resolve })
  const result = await refreshMicrophoneDevices(() => pending, { timeoutMs: 5 })
  assert.equal(result.status, 'timeout'); finish([{ deviceId: 'late', label: 'Late device' }]); await Promise.resolve(); assert.deepEqual(result.devices, [])
  const controller = new AbortController(); controller.abort(); let called = false
  assert.equal((await refreshMicrophoneDevices(async () => { called = true; return [] }, { signal: controller.signal })).status, 'cancelled'); assert.equal(called, false)
  const failed = await refreshMicrophoneDevices(async () => { throw new Error('PRIVATE_PATH_OR_PROVIDER_TOKEN') })
  assert.equal(failed.status, 'failed'); assert(!JSON.stringify(failed).includes('PRIVATE'))
})
