import { darwinPlatform } from './darwin'
import { linuxPlatform } from './linux'
import { win32Platform } from './win32'
import type { DesktopPlatform, PlatformId } from './types'

export * from './types'
export { darwinPlatform } from './darwin'
export { linuxPlatform } from './linux'
export { win32Platform } from './win32'

/** Normalizes Node's platform names onto the three desktop platforms Faangin ships for. */
export function platformId(platform: string = process.platform): PlatformId {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux'
}

/** Selects the implementation for `platform`; tests pass an explicit id, production uses the running OS. */
export function desktopPlatform(platform: string = process.platform): DesktopPlatform {
  switch (platformId(platform)) {
    case 'darwin': return darwinPlatform
    case 'win32': return win32Platform
    default: return linuxPlatform
  }
}

/** The platform the current process runs on. Import this in `src/main/index.ts` instead of checking `process.platform`. */
export const platform: DesktopPlatform = desktopPlatform()
