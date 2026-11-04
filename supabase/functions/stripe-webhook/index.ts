import Stripe from 'npm:stripe@23.0.1'
import { createRuntime, type AccountRuntime } from '../_shared/account-runtime.ts'
import { boundedText, cors, errorResponse, json } from '../_shared/http.ts'
import { ServiceError } from '../../../backend/supabase/errors.ts'
export function createStripeWebhookHandler(runtime: () => AccountRuntime = createRuntime) {
  return async (request: Request): Promise<Response> => {
    let headers = new Headers({ 'cache-control': 'no-store' })
    try {
      headers = cors(request)
      if (request.method !== 'POST') return json({ error: { status: 'INVALID_ARGUMENT', message: 'POST only' } }, 405, headers)
      const signature = request.headers.get('stripe-signature')
      if (!signature) return json({ error: { status: 'INVALID_ARGUMENT', message: 'Invalid Stripe signature' } }, 400, headers)
      const service = runtime(), secret = service.env.get('STRIPE_WEBHOOK_SECRET')
      if (!secret) throw new ServiceError('unavailable', 'Payment confirmation is not configured yet')
      const raw = await boundedText(request, 1_048_576)
      const billing = service.billing('webhook')
      let event: Stripe.Event
      try { event = await billing.stripe.webhooks.constructEventAsync(raw, signature, secret, undefined, Stripe.createSubtleCryptoProvider()) }
      catch { return json({ error: { status: 'INVALID_ARGUMENT', message: 'Invalid Stripe signature' } }, 400, headers) }
      return json(await billing.service.processWebhook(event), 200, headers)
    } catch (error) { return errorResponse(error, headers) }
  }
}
export const handler = createStripeWebhookHandler()
if (import.meta.main) Deno.serve(handler)
