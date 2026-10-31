import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { DeviceInfo } from '../faangin-cloud'

const SALT_FILE = '.device-salt'
const NAME_LIMIT = 64

export interface DeviceIdentityOptions {
  userDataPath: string
  hostname?: () => string
}

/**
 * A stable per-install device for the 3-device cap. The id is sha256(hostname, salt) as 64 hex characters, which
 * the server accepts (`[A-Za-z0-9_-]{8,64}`); the salt is created once in userData, so a reinstall that loses it
 * counts as a new device, and copying userData to another Mac (different hostname) does too.
 */
export class DeviceIdentity {
  private cached: DeviceInfo | null = null

  constructor(private readonly options: DeviceIdentityOptions) {}

  async get(): Promise<DeviceInfo> {
    if (this.cached) return this.cached
    const host = (this.options.hostname ?? hostname)()
    const salt = await this.salt()
    const deviceId = createHash('sha256').update(host).update('\0').update(salt).digest('hex')
    this.cached = { deviceId, deviceName: host.trim().slice(0, NAME_LIMIT) || 'Mac' }
    return this.cached
  }

  private async salt(): Promise<string> {
    const path = join(this.options.userDataPath, SALT_FILE)
    try {
      const existing = (await readFile(path, 'utf8')).trim()
      if (existing.length >= 32) return existing
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const created = randomBytes(32).toString('hex')
    await mkdir(this.options.userDataPath, { recursive: true })
    await writeFile(path, created, { encoding: 'utf8', mode: 0o600 })
    return created
  }
}
