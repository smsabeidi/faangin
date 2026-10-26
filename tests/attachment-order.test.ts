import assert from 'node:assert/strict'
import test from 'node:test'
import { reorderSessionAttachments } from '../src/main/attachment-order'

const image = (id: string, sessionId = 'interview') => Object.freeze({ id, sessionId, name: `Screenshot ${id}`, dataUrl: `fixture:${id}` })

test('reordering uses tray order for selected images while preserving consent and image metadata', () => {
  const images = Object.freeze([image('a'), image('b'), image('c'), image('d')])
  const order = Object.freeze(['d', 'c', 'a', 'b']), selected = Object.freeze(['a', 'd'])
  const result = reorderSessionAttachments('interview', images, order, selected)
  assert.deepEqual(result.attachments.map(attachment => attachment.id), order)
  assert.deepEqual(result.selectedIds, ['d', 'a'])
  assert.strictEqual(result.attachments[0], images[3])
  assert.strictEqual(result.attachments[2], images[0])
  assert.deepEqual(images.map(attachment => attachment.id), ['a', 'b', 'c', 'd'])
  assert.deepEqual(selected, ['a', 'd'])
})

test('empty consent stays empty when images are reordered', () => {
  const result = reorderSessionAttachments('interview', [image('a'), image('b')], ['b', 'a'], [])
  assert.deepEqual(result.selectedIds, [])
  assert.deepEqual(result.attachments.map(attachment => attachment.id), ['b', 'a'])
})

test('empty and unchanged trays return independent arrays', () => {
  const images = [image('a')], selected = ['a'], order = ['a']
  const result = reorderSessionAttachments('interview', images, order, selected)
  result.attachments.pop()
  result.selectedIds.pop()
  assert.deepEqual(images.map(attachment => attachment.id), ['a'])
  assert.deepEqual(selected, ['a'])
  assert.deepEqual(order, ['a'])
  assert.deepEqual(reorderSessionAttachments('interview', [], [], []), { attachments: [], selectedIds: [] })
})

test('stale, partial, excess, duplicate and foreign orders fail without mutating the tray or consent', () => {
  const images = Object.freeze([image('a'), image('b')]), selected = Object.freeze(['b'])
  for (const order of [['a'], ['a', 'b', 'c'], ['a', 'a'], ['a', 'other-session-image'], ['b', 'removed-image']]) {
    assert.throws(() => reorderSessionAttachments('interview', images, Object.freeze(order), selected), /Image order changed|more than once|no longer available/)
    assert.deepEqual(images.map(attachment => attachment.id), ['a', 'b'])
    assert.deepEqual(selected, ['b'])
  }
  assert.deepEqual(reorderSessionAttachments('interview', images, ['b', 'a'], selected).selectedIds, ['b'])
})

test('a foreign session attachment cannot be adopted even when its ID appears in a complete order', () => {
  const images = Object.freeze([image('a'), image('b', 'other')])
  assert.throws(() => reorderSessionAttachments('interview', images, ['b', 'a'], ['a']), /different session/)
  assert.deepEqual(images.map(attachment => attachment.sessionId), ['interview', 'other'])
})

test('an ambiguous stored tray rejects duplicate attachment IDs', () => {
  assert.throws(() => reorderSessionAttachments('interview', [image('a'), image('a')], ['a', 'a'], []), /tray contains a repeated image/)
})

test('invalid existing consent prevents the whole reorder from being committed', () => {
  const images = Object.freeze([image('a'), image('b'), image('c'), image('d'), image('e')])
  const order = Object.freeze(['e', 'd', 'c', 'b', 'a'])
  const cases = [
    { selected: ['removed-image'], message: /selected image is no longer available/ },
    { selected: ['a', 'a'], message: /selected more than once/ },
    { selected: ['a', 'b', 'c', 'd', 'e'], message: /at most four/ }
  ]
  for (const { selected, message } of cases) {
    const original = [...selected]
    assert.throws(() => reorderSessionAttachments('interview', images, order, Object.freeze(selected)), message)
    assert.deepEqual(selected, original)
    assert.deepEqual(images.map(attachment => attachment.id), ['a', 'b', 'c', 'd', 'e'])
    assert.deepEqual(order, ['e', 'd', 'c', 'b', 'a'])
  }
})

test('all selected images can be reordered without silently adding unselected images', () => {
  const images = [image('a'), image('b'), image('c'), image('d'), image('e')]
  const result = reorderSessionAttachments('interview', images, ['e', 'd', 'c', 'b', 'a'], ['a', 'b', 'c', 'd'])
  assert.deepEqual(result.selectedIds, ['d', 'c', 'b', 'a'])
  assert.ok(!result.selectedIds.includes('e'))
  assert.equal(result.attachments.length, 5)
})
