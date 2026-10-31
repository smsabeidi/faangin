import { setGlobalOptions } from 'firebase-functions'
import { REGION } from './config.js'

setGlobalOptions({ region: REGION, maxInstances: 20 })

export * from './auth/device-code.js'
export * from './license/issue.js'
export * from './billing/checkout.js'
export * from './billing/webhook.js'
export * from './billing/reconcile.js'
