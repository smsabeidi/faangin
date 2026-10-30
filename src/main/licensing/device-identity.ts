/**
 * Stable per-install Mac descriptor. deviceId is a sha256 of
 * (hostname + machineId + salt), where salt is persisted once in
 * userData/.device-salt. Rotating the salt means a reinstall counts
 * as a new device - which is what we want for the 3-device cap.
 */

import { promises as fs } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { DeviceDescriptor } from '../../shared/billing-types'
import { BILLING_FILE_NAMES } from '../../shared/billing-storage'

export interface DeviceIdentityOptions {
  userDataPath: string
  /**
   * Opaque per-machine ID. On production builds we delegate to Electron's
   * app.getPath('userData') + a persisted salt; a stable machine ID like
   * macOS IOPlatformUUID can be fed here when it is available. Tests pass
   * a fixture value directly.
   */
  machineId?: string
  hostname?: string
  label?: string
  nowSeconds?: () => number
}

export class DeviceIdentity {
  private readonly options: DeviceIdentityOptions
  private cached: DeviceDescriptor | null = null

  constructor(options: DeviceIdentityOptions) {
    this.options = options
  }

  async getDescriptor(): Promise<DeviceDescriptor> {
    if (this.cached) return this.touch(this.cached)
    const salt = await this.readOrCreateSalt()
    const host = this.options.hostname ?? hostname()
    const machineId = this.options.machineId ?? host
    const deviceId = createHash('sha256')
      .update(host)
      .update('\0')
      .update(machineId)
      .update('\0')
      .update(salt)
      .digest('hex')
    const now = (this.options.nowSeconds ?? defaultNow)()
    const descriptor: DeviceDescriptor = {
      deviceId,
      label: this.options.label ?? host,
      activatedAt: now,
      lastSeenAt: now,
    }
    this.cached = descriptor
    return descriptor
  }

  private touch(descriptor: DeviceDescriptor): DeviceDescriptor {
    const now = (this.options.nowSeconds ?? defaultNow)()
    const updated: DeviceDescriptor = { ...descriptor, lastSeenAt: now }
    this.cached = updated
    return updated
  }

  private async readOrCreateSalt(): Promise<string> {
    const path = join(this.options.userDataPath, BILLING_FILE_NAMES.deviceSalt)
    try {
      const existing = (await fs.readFile(path, 'utf8')).trim()
      if (existing.length >= 32) return existing
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const salt = randomBytes(32).toString('hex')
    await fs.mkdir(this.options.userDataPath, { recursive: true })
    await fs.writeFile(path, salt, { encoding: 'utf8', mode: 0o600 })
    return salt
  }
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000)
}

let defaultIdentity: DeviceIdentity | null = null

export function initializeDeviceIdentity(options: DeviceIdentityOptions): DeviceIdentity {
  defaultIdentity = new DeviceIdentity(options)
  return defaultIdentity
}

export async function getDeviceDescriptor(): Promise<DeviceDescriptor> {
  if (!defaultIdentity) {
    throw new Error('Device identity not initialised; call initializeDeviceIdentity first.')
  }
  return defaultIdentity.getDescriptor()
}
