import assert from 'node:assert/strict'
import test from 'node:test'
import { attachmentSelectionSummary, attachmentTrayVisible } from '../src/renderer/src/composer-attachments'

test('new selected captures do not expand the compact composer; only deliberate expansion does', () => {
  for (const selectedCount of [0, 1, 2, 4]) {
    assert.equal(attachmentTrayVisible(true, selectedCount, false), false)
    assert.equal(attachmentTrayVisible(true, selectedCount, true), true)
  }
  // A collapsed overlay stays collapsed when a new screenshot becomes selected.
  assert.equal(attachmentTrayVisible(true, 1, false), attachmentTrayVisible(true, 2, false))
})

test('workspace selected-image visibility stays automatic and empty selection still allows deliberate review', () => {
  assert.equal(attachmentTrayVisible(false, 1, false), true)
  assert.equal(attachmentTrayVisible(false, 4, false), true)
  assert.equal(attachmentTrayVisible(false, 0, false), false)
  assert.equal(attachmentTrayVisible(false, 0, true), true)
})

test('the compact disclosure states the selected count without suggesting all saved images will be sent', () => {
  assert.equal(attachmentSelectionSummary(1, 5), '1 screenshot selected')
  assert.equal(attachmentSelectionSummary(2, 5), '2 screenshots selected')
  assert.equal(attachmentSelectionSummary(0, 5), '5 saved screenshots · none selected')
  assert.equal(attachmentSelectionSummary(0, 1), '1 saved screenshot · none selected')
})
