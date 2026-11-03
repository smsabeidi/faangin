export function handler(request: Request): Response {
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  if (request.method !== 'GET') return new Response('GET only', { status: 405, headers })
  const path = new URL(request.url).pathname
  const text = path.endsWith('/billing/cancel') ? 'Checkout was canceled. Return to Faangin to choose a plan when you are ready.'
    : path.endsWith('/billing/success') ? 'Thank you. Your payment is being confirmed. Return to Faangin; your plan will refresh automatically. If needed, choose Refresh license.'
      : 'Return to Faangin and open Account & billing to sign in, choose a plan, or manage your subscription.'
  return new Response(text, { headers })
}
if (import.meta.main) Deno.serve(handler)
