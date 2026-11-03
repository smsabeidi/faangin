let counter = 0
export function fakeEvent(type: string, object: Record<string, unknown>, overrides: Record<string, unknown> = {}) { return { id: `evt_fixture_${++counter}`, object: 'event', livemode: false, type, data: { object }, ...overrides } }
export interface FakeSubscriptionOptions {
  id?: string; status?: string; customer?: string; uid?: string; cancelAtPeriodEnd?: boolean; cancelAt?: number | null
  periodStart?: number; periodEnd?: number; lookupKey?: string
  /** Old API shape: period on the subscription itself instead of its first item. */
  topLevelPeriod?: boolean
}

/** A subscription in the API 2025-03-31+ shape (period on items.data[0]), or the older top-level shape. */
export function fakeSubscription(options: FakeSubscriptionOptions = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  const start = options.periodStart ?? now
  const end = options.periodEnd ?? now + 30 * 86400
  const period = { current_period_start: start, current_period_end: end }
  const lookupKey = options.lookupKey ?? 'faangin_pro_monthly'
  return {
    id: options.id ?? 'sub_fake', object: 'subscription', status: options.status ?? 'active',
    customer: options.customer ?? 'cus_fake', cancel_at_period_end: options.cancelAtPeriodEnd ?? false, cancel_at: options.cancelAt ?? null,
    metadata: options.uid ? { uid: options.uid, plan: 'pro_monthly' } : {},
    start_date: start,
    ...(options.topLevelPeriod ? period : {}),
    items: {
      object: 'list',
      data: [{
        id: 'si_fake', object: 'subscription_item',
        ...(options.topLevelPeriod ? {} : period),
        price: { id: `price_${lookupKey}`, object: 'price', lookup_key: lookupKey }
      }]
    }
  }
}
