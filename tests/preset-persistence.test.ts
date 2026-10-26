import assert from 'node:assert/strict'
import test from 'node:test'
import { PresetCatalog } from '../src/main/presets'
import { durablePresetSnapshot } from '../src/main/preset-persistence'

test('private shadow changes retain the original saved choice while new RAM choices stay transient', () => {
  const catalog = new PresetCatalog()
  catalog.select('saved', 'interview', 'response', 'builtin:interview-coach')
  const previous = catalog.snapshot()
  catalog.select('saved', 'interview', 'response', 'builtin:system-design')
  catalog.select('ram', 'interview', 'response', 'builtin:interview-coach')
  const before = catalog.snapshot(), durable = durablePresetSnapshot(before, previous, id => ({ persistent: false, savedSnapshot: id === 'saved', mode: 'interview' }))
  assert.equal(durable.choices.saved.responseId, 'builtin:interview-coach')
  assert.equal(durable.choices.ram, undefined)
  assert.equal(catalog.snapshot().choices.saved.responseId, 'builtin:system-design')
  assert.deepEqual(catalog.snapshot(), before); assert.deepEqual(previous.choices.saved, durable.choices.saved)
})

test('saved reset and permanent deletion revoke choices, while a RAM reset preserves its saved baseline', () => {
  const catalog = new PresetCatalog(); catalog.select('saved', 'interview', 'response', 'builtin:interview-coach')
  const previous = catalog.snapshot(); catalog.clearSession('saved')
  assert.equal(durablePresetSnapshot(catalog.snapshot(), previous, () => ({ persistent: true, savedSnapshot: true, mode: 'interview' })).choices.saved, undefined)
  assert.equal(durablePresetSnapshot(catalog.snapshot(), previous, () => null).choices.saved, undefined)
  assert.equal(durablePresetSnapshot(catalog.snapshot(), previous, () => ({ persistent: false, savedSnapshot: true, mode: 'interview' })).choices.saved.responseId, 'builtin:interview-coach')
})

test('explicit global preset deletion revokes saved-shadow references without reviving deleted defaults', () => {
  const catalog = new PresetCatalog(); catalog.select('saved', 'interview', 'response', 'builtin:interview-coach')
  const previous = catalog.snapshot(); catalog.delete('builtin:interview-coach')
  const durable = durablePresetSnapshot(catalog.snapshot(), previous, () => ({ persistent: false, savedSnapshot: true, mode: 'interview' }))
  assert.equal(durable.choices.saved.responseId, null); assert(!durable.presets.some(preset => preset.id === 'builtin:interview-coach'))
})
