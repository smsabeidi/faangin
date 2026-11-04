export type SetupPermission = 'microphone' | 'screen'
export interface PermissionSetupPorts {
  /** True only where the OS shows its own per-app prompts (macOS); elsewhere the privacy settings page is the only path. */
  promptsNatively: boolean
  status: (kind: SetupPermission) => string
  requestMicrophone: () => Promise<boolean>
  enumerateScreens: () => Promise<unknown>
  openSettings: (kind: SetupPermission) => Promise<void>
}

/** Called only by the user's explicit setup action; never starts audio or stores a screen image. */
export async function requestSetupPermission(kind: SetupPermission, ports: PermissionSetupPorts): Promise<void> {
  const current = ports.status(kind)
  if (current === 'granted') return
  if (!ports.promptsNatively || current === 'denied' || current === 'restricted') {
    await ports.openSettings(kind)
    return
  }
  if (kind === 'microphone') {
    await ports.requestMicrophone()
    return
  }
  // Enumerating without thumbnails makes a first screen-access request register in macOS.
  // A denied request may reject, so keep the path to the system's permission controls available.
  try { await ports.enumerateScreens() } catch {
    if (ports.status(kind) === 'granted') throw new Error('Screen access is enabled, but screens could not be listed. Try again after restarting Faangin.')
  }
  if (ports.status(kind) !== 'granted') await ports.openSettings(kind)
}
