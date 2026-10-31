import type { BillingSummary } from '../../shared/billing-types'
import { AccountStore, type SecretBox } from './account-store'
import { resolveCloudConfig } from './config'
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
}

export function createLicensing(environment: LicensingEnvironment): LicenseService {
  return new LicenseService({
    config: resolveCloudConfig({ env: environment.env, packaged: environment.packaged }),
    store: new AccountStore({ userDataPath: environment.userDataPath, secrets: environment.secrets }),
    identity: new DeviceIdentity({ userDataPath: environment.userDataPath }),
    openExternal: environment.openExternal,
    encryptionAvailable: environment.secrets.available,
    onChange: environment.onChange
  })
}
