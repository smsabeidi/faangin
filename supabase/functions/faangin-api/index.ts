import { createRuntime, type AccountRuntime } from '../_shared/account-runtime.ts'
import { authorizeReconciliation } from '../_shared/reconcile-auth.ts'
import { body, cors, errorResponse, json } from '../_shared/http.ts'
import { ServiceError } from '../../../backend/supabase/errors.ts'
const ROUTES = new Set(['deviceCodeStart', 'deviceCodePoll', 'deviceCodeApprove', 'issueLicense', 'createCheckoutSession', 'createPortalSession', 'reconcile'])
export function createAccountHandler(runtime: () => AccountRuntime = createRuntime) {
  return async (request: Request): Promise<Response> => {
    let headers = new Headers({ 'cache-control': 'no-store' })
    try {
      headers = cors(request)
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
      const path = new URL(request.url).pathname
      const match = /^(?:\/functions\/v1)?\/faangin-api(?:\/([A-Za-z]+))?\/?$/.exec(path)
      const route = match?.[1]
      if (match && request.method === 'GET' && (!route || route === 'health')) {
        const service = runtime()
        return json({ ok: true, authConfigured: service.authConfigured, licenseConfigured: !!service.env.get('LICENSE_SIGNING_KEY'), billingConfigured: service.billingConfigured }, 200, headers)
      }
      if (!route || !ROUTES.has(route)) return json({ error: { status: 'NOT_FOUND', message: 'Unknown account route' } }, 404, headers)
      if (request.method !== 'POST') return json({ error: { status: 'INVALID_ARGUMENT', message: 'POST only' } }, 405, headers)
      const service = runtime()
      if (route === 'reconcile') {
        await authorizeReconciliation(service, request)
        return json({ result: await service.billing('webhook').service.reconcile() }, 200, headers)
      }
      if (route === 'deviceCodeStart') return json(await service.account.start(await body(request)), 200, headers)
      if (route === 'deviceCodePoll') return json(await service.account.poll(await body(request)), 200, headers)
      const user = await service.user(request), envelope = await body(request)
      if (!Object.hasOwn(envelope, 'data')) throw new ServiceError('invalid-argument', 'Callable requests must contain data')
      let result: unknown
      switch (route) {
        case 'deviceCodeApprove': result = await service.account.approve(user.id, envelope.data); break
        case 'issueLicense':
          if (!service.env.get('LICENSE_SIGNING_KEY')) throw new ServiceError('unavailable', 'Licensing is not configured yet')
          result = await service.account.issueLicense(user.id, envelope.data); break
        case 'createCheckoutSession': result = await service.billing('checkout').service.checkout(user, envelope.data); break
        case 'createPortalSession': result = await service.billing('portal').service.portal(user); break
      }
      return json({ result }, 200, headers)
    } catch (error) { return errorResponse(error, headers) }
  }
}
export const handler = createAccountHandler()
if (import.meta.main) Deno.serve(handler)
