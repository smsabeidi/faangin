import assert from 'node:assert/strict'
import test from 'node:test'
import { handleSettingsShortcut, primaryModifierPressed } from '../src/renderer/src/settings-shortcut'

test('Settings from the overlay opens the workspace while workspace Settings stays local on both modifier conventions', () => {
  for (const modifier of ['metaKey', 'ctrlKey'] as const) {
    for (const windowKind of ['overlay', 'workspace'] as const) {
      const calls: string[] = []
      const event = { key: ',', metaKey: false, ctrlKey: false, [modifier]: true, preventDefault() { calls.push('prevent') } }
      const handled = handleSettingsShortcut(event, windowKind, async () => { calls.push('workspace-settings') }, () => { calls.push('local-settings') })
      assert.equal(handled, true)
      assert.deepEqual(calls, ['prevent', windowKind === 'overlay' ? 'workspace-settings' : 'local-settings'])
    }
  }
})

test('typing commas and unrelated assistance/capture keys cannot open Settings or consume their events', () => {
  for (const event of [
    { key: ',', metaKey: false, ctrlKey: false },
    { key: 'Enter', metaKey: true, ctrlKey: false },
    { key: 's', metaKey: false, ctrlKey: true },
    { key: 'Escape', metaKey: true, ctrlKey: false },
  ]) {
    let touched = false
    const mark = () => { touched = true }
    assert.equal(handleSettingsShortcut({ ...event, preventDefault: mark }, 'overlay', async () => { mark() }, mark), false)
    assert.equal(touched, false)
  }
})

test('once the platform is known only its primary modifier opens Settings, so the Windows key and a stray Ctrl on macOS are ignored', () => {
  for (const [platform, primary, foreign] of [['darwin', 'metaKey', 'ctrlKey'], ['win32', 'ctrlKey', 'metaKey'], ['linux', 'ctrlKey', 'metaKey']] as const) {
    const calls: string[] = []
    const mark = () => { calls.push(platform) }
    assert.equal(handleSettingsShortcut({ key: ',', metaKey: false, ctrlKey: false, [primary]: true, preventDefault: mark }, 'workspace', async () => { mark() }, mark, platform), true)
    assert.deepEqual(calls, [platform, platform])
    assert.equal(handleSettingsShortcut({ key: ',', metaKey: false, ctrlKey: false, [foreign]: true, preventDefault: mark }, 'overlay', async () => { mark() }, mark, platform), false)
    assert.deepEqual(calls, [platform, platform])
    assert.equal(primaryModifierPressed({ metaKey: false, ctrlKey: false, [primary]: true }, platform), true)
    assert.equal(primaryModifierPressed({ metaKey: false, ctrlKey: false, [foreign]: true }, platform), false)
  }
  assert.equal(primaryModifierPressed({ metaKey: true, ctrlKey: false }), true)
  assert.equal(primaryModifierPressed({ metaKey: false, ctrlKey: true }, undefined), true)
  assert.equal(primaryModifierPressed({ metaKey: false, ctrlKey: false }, 'win32'), false)
})
