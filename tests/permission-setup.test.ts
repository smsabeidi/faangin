import assert from 'node:assert/strict'
import test from 'node:test'
import { requestSetupPermission, type PermissionSetupPorts, type SetupPermission } from '../src/main/permission-setup'

function fixture(patch: Partial<PermissionSetupPorts> = {}) {
  const actions: string[] = []
  const states: Record<SetupPermission, string> = { microphone: 'not-determined', screen: 'not-determined' }
  const ports: PermissionSetupPorts = {
    platform: 'darwin', status: kind => states[kind],
    requestMicrophone: async () => { actions.push('microphone'); states.microphone = 'granted'; return true },
    enumerateScreens: async () => { actions.push('screens'); states.screen = 'granted' },
    openSettings: async kind => { actions.push(`settings:${kind}`) },
    ...patch
  }
  return { actions, states, ports }
}

test('first-time microphone setup requests native consent without opening or starting a capture', async () => {
  const setup = fixture()
  await requestSetupPermission('microphone', setup.ports)
  assert.deepEqual(setup.actions, ['microphone'])
  assert.equal(setup.states.microphone, 'granted')
})

test('first-time screen setup enumerates screens and reports actual OS permission only', async () => {
  const granted = fixture()
  await requestSetupPermission('screen', granted.ports)
  assert.deepEqual(granted.actions, ['screens'])
  const denied = fixture({ enumerateScreens: async () => { throw new Error('Denied') } })
  await requestSetupPermission('screen', denied.ports)
  assert.deepEqual(denied.actions, ['settings:screen'])
  assert.equal(denied.states.screen, 'not-determined')
})

test('previously denied access opens system settings without repeating native prompts', async () => {
  for (const kind of ['microphone', 'screen'] as const) {
    const setup = fixture(); setup.states[kind] = 'denied'
    await requestSetupPermission(kind, setup.ports)
    assert.deepEqual(setup.actions, [`settings:${kind}`])
  }
})

test('granted access is a no-op and non-Mac systems use their privacy controls', async () => {
  const allowed = fixture(); allowed.states.microphone = 'granted'
  await requestSetupPermission('microphone', allowed.ports)
  assert.deepEqual(allowed.actions, [])
  const windows = fixture({ platform: 'win32' })
  await requestSetupPermission('microphone', windows.ports)
  assert.deepEqual(windows.actions, ['settings:microphone'])
})
