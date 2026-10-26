import assert from 'node:assert/strict'
import test from 'node:test'
import { AttachmentSelection } from '../src/main/attachment-selection'

test('background Solve uses explicit selection and does not reselect deselected screenshots', () => {
  const selection = new AttachmentSelection()
  selection.added('interview', 'first-screen')
  selection.added('interview', 'second-screen')
  selection.set('interview', ['second-screen'], ['first-screen', 'second-screen'])
  assert.deepEqual(selection.get('interview'), ['second-screen'])
  selection.added('interview', 'third-screen')
  assert.deepEqual(selection.get('interview'), ['second-screen', 'third-screen'])
  selection.removed('interview', 'third-screen')
  assert.deepEqual(selection.get('interview'), ['second-screen'])
})

test('selection validation rejects unavailable, repeated, and excess images without losing consent', () => {
  const selection = new AttachmentSelection()
  const available = ['a', 'b', 'c', 'd', 'e']
  selection.set('interview', ['a'], available)
  assert.throws(() => selection.set('interview', ['foreign-session-image'], available), /no longer available in this session/)
  assert.throws(() => selection.set('interview', ['a', 'a'], available), /more than once/)
  assert.throws(() => selection.set('interview', available, available), /at most four/)
  assert.deepEqual(selection.get('interview'), ['a'])
})

test('new images are selected only while capacity remains and removals prune selection', () => {
  const selection = new AttachmentSelection()
  for (const id of ['a', 'b', 'c', 'd', 'e']) selection.added('interview', id)
  assert.deepEqual(selection.get('interview'), ['a', 'b', 'c', 'd'])
  selection.added('interview', 'b')
  assert.deepEqual(selection.get('interview'), ['a', 'b', 'c', 'd'])
  selection.removed('interview', 'b')
  selection.added('interview', 'f')
  assert.deepEqual(selection.get('interview'), ['a', 'c', 'd', 'f'])
  selection.removed('interview', 'e')
  assert.deepEqual(selection.get('interview'), ['a', 'c', 'd', 'f'])
})

test('sessions stay isolated and reset or deletion forgets only its own selection', () => {
  const selection = new AttachmentSelection()
  selection.set('first', ['first-image'], ['first-image'])
  selection.set('second', ['second-image'], ['second-image'])
  assert.throws(() => selection.set('second', ['first-image'], ['second-image']), /no longer available in this session/)
  selection.clear('first')
  assert.deepEqual(selection.get('first'), [])
  assert.deepEqual(selection.get('second'), ['second-image'])
  selection.added('first', 'new-image')
  assert.deepEqual(selection.get('first'), ['new-image'])
  selection.clear('second')
  assert.deepEqual(selection.get('second'), [])
})

test('caller-owned arrays cannot change saved selection', () => {
  const selection = new AttachmentSelection()
  const ids = ['a']
  const saved = selection.set('interview', ids, ['a', 'b'])
  ids.push('b')
  saved.push('b')
  selection.get('interview').splice(0)
  assert.deepEqual(selection.get('interview'), ['a'])
  selection.set('interview', [], ['a', 'b'])
  assert.deepEqual(selection.get('interview'), [])
})

test('a stale window cannot request an image deselected in another window', () => {
  const selection = new AttachmentSelection(), available = ['first-screen', 'second-screen']
  selection.set('interview', available, available)
  const staleWindowIds = selection.get('interview')
  selection.set('interview', ['second-screen'], available)
  assert.throws(() => selection.validateRequested('interview', staleWindowIds, available), /Refresh the workspace and reselect images/)
  assert.throws(() => selection.validateRequested('interview', ['first-screen'], available), /Screenshot selection changed/)
  assert.deepEqual(selection.validateRequested('interview', ['second-screen'], available), ['second-screen'])
  assert.deepEqual(selection.get('interview'), ['second-screen'])
})

test('a valid request may use a subset of selected images without changing selection or request order', () => {
  const selection = new AttachmentSelection(), available = ['a', 'b', 'c', 'd']
  selection.set('interview', available, available)
  const requested = ['d', 'b']
  const admitted = selection.validateRequested('interview', requested, available)
  assert.deepEqual(admitted, requested)
  admitted.push('a')
  requested.splice(0)
  assert.deepEqual(selection.get('interview'), available)
  assert.deepEqual(selection.validateRequested('interview', [], available), [])
})

test('reset or deletion revokes old-window requests even when a stale attachment list remains', () => {
  const selection = new AttachmentSelection()
  selection.set('first', ['old-image'], ['old-image'])
  selection.set('second', ['other-image'], ['other-image'])
  selection.clear('first')
  assert.throws(() => selection.validateRequested('first', ['old-image'], ['old-image']), /Refresh the workspace and reselect images/)
  assert.deepEqual(selection.validateRequested('second', ['other-image'], ['other-image']), ['other-image'])
  selection.added('first', 'new-image')
  assert.throws(() => selection.validateRequested('first', ['old-image'], ['new-image']), /Screenshot selection changed/)
  assert.deepEqual(selection.validateRequested('first', ['new-image'], ['new-image']), ['new-image'])
})

test('request admission also rejects removed, foreign-session, repeated and excess image IDs', () => {
  const selection = new AttachmentSelection()
  selection.set('interview', ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'])
  assert.throws(() => selection.validateRequested('interview', ['a'], ['b', 'c', 'd']), /Screenshot selection changed/)
  assert.throws(() => selection.validateRequested('other-session', ['a'], ['a']), /Screenshot selection changed/)
  assert.throws(() => selection.validateRequested('interview', ['a', 'a'], ['a', 'b', 'c', 'd']), /more than once/)
  assert.throws(() => selection.validateRequested('interview', ['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'e']), /at most four/)
  assert.deepEqual(selection.get('interview'), ['a', 'b', 'c', 'd'])
})
