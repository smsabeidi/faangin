import type { BillingSummary } from '../../shared/billing-types'
import { AccountStore, type SecretBox } from './account-store'
import { resolveCloudConfig, type CloudConfig } from './config'
import { DeviceIdentity } from './device-identity'
import { LicenseService } from './service'

export { LicenseService } from './service'

export interface LicensingEnvironment {
  userDataPath: string
  packaged: boolean
  env: Readonly<Record<string, string | undefined>>
  secrets: SecretBox
  openExternal: (url: string) => Promise<void>
  onChange: (summary: BillingSummary) => void
  /** Device label when the hostname is empty; production passes `platform.defaultDeviceName` so it reads naturally per OS. */
  defaultDeviceName?: string
  /** Explicit injection for owned disposable fixtures; omitted in normal launches. */
  cloudConfig?: CloudConfig | null
}

export function createLicensing(environment: LicensingEnvironment): LicenseService {
  return new LicenseService({
    config: environment.cloudConfig === undefined ? resolveCloudConfig({ env: environment.env, packaged: environment.packaged }) : environment.cloudConfig,
    store: new AccountStore({ userDataPath: environment.userDataPath, secrets: environment.secrets }),
    identity: new DeviceIdentity({ userDataPath: environment.userDataPath, defaultDeviceName: environment.defaultDeviceName }),
    openExternal: environment.openExternal,
    encryptionAvailable: environment.secrets.available,
    onChange: environment.onChange
  })
}
