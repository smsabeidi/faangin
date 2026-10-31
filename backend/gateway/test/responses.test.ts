import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { MODELS } from '../src/config.js'
import { NOW, parseSse, PERIOD_KEY, post, proEntitlement, startFakeOpenAI, startGateway, TODAY, until, type FakeOpenAI, type Gateway } from './support.js'

let fake: FakeOpenAI
let gw: Gateway
let n = 0
let uid: string
let token: string

before(async () => {
  fake = await startFakeOpenAI()
  gw = await startGateway(fake)
})
after(async () => {
  await gw.close()
  await fake.close()
})
beforeEach(() => {
  uid = `resp${++n}`
  token = `tok-${uid}`
  gw.entitlements.set(uid, proEntitlement())
  gw.flags.smartToFast = false
  gw.flags.handsfreeOff = false
  gw.clock.now = NOW
  fake.requests.length = 0
  fake.usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 500, total_tokens: 1500 }
  fake.finalEvent = 'response.completed'
  fake.hold = false
  fake.next = undefined
})

const usage = () => gw.store.read(uid, PERIOD_KEY)
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string; allowance?: string } }).error

describe('POST /v1/responses', () => {
  it('rejects a model that is not a mode', async () => {
    const res = await post(gw, token, { model: 'gpt-4o', input: 'hi' })
    assert.equal(res.status, 400)
    assert.equal((await errorCode(res)).code, 'invalid_mode')
    assert.equal(fake.requests.length, 0)
  })

  it('forwards only the allowlist with the server model, stream true, store false and a capped max_output_tokens', async () => {
    const res = await post(gw, token, {
      model: 'smart', input: 'hi', instructions: 'be nice', max_output_tokens: 99_999, reasoning: { effort: 'low' }, text: { format: { type: 'text' } },
      truncation: 'auto', prompt_cache_key: 'k1', tools: [{ type: 'web_search' }], previous_response_id: 'resp_0', metadata: { a: 1 }, store: true, stream: false, temperature: 0.1
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.equal(await res.text(), fake.lastStream)
    assert.equal(fake.requests.length, 1)
    const { headers, body } = fake.requests[0]
    assert.equal(headers.authorization, 'Bearer test-openai-key')
    assert.deepEqual(body, {
      input: 'hi', instructions: 'be nice', max_output_tokens: 4096, reasoning: { effort: 'low' }, text: { format: { type: 'text' } },
      truncation: 'auto', prompt_cache_key: 'k1', model: MODELS.smart, stream: true, store: false
    })
    assert.equal(res.headers.get('x-faangin-mode'), null)
  })

  it('increments the mode counter and settles the cost from usage', async () => {
    const res = await post(gw, token, { model: 'fast', input: 'hi' })
    assert.equal(res.status, 200)
    assert.equal((await usage()).fast, 1)
    await res.text()
    await until(async () => (await usage()).spendUsd > 0)
    const u = await usage()
    assert.ok(Math.abs(u.spendUsd - 0.00114) < 1e-12)
    assert.ok(Math.abs(u.days[TODAY].spendUsd - 0.00114) < 1e-12)
  })

  it('settles a stream without usage at the cap estimate', async () => {
    fake.usage = null
    await (await post(gw, token, { model: 'fast', input: 'hi' })).text()
    await until(async () => (await usage()).spendUsd > 0)
    assert.ok(Math.abs((await usage()).spendUsd - 0.0129536) < 1e-12)
  })

  it('settles the cost from usage when the stream ends incomplete or failed, not at the cap estimate', async () => {
    for (const finalEvent of ['response.incomplete', 'response.failed']) {
      fake.finalEvent = finalEvent
      const res = await post(gw, token, { model: 'fast', input: 'hi' })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), fake.lastStream)
    }
    await until(async () => (await usage()).spendUsd >= 2 * 0.00114 - 1e-12)
    assert.ok(Math.abs((await usage()).spendUsd - 2 * 0.00114) < 1e-12)
  })

  it('runs smart as fast at the smart cap and says so in a header', async () => {
    await gw.store.increment(uid, PERIOD_KEY, TODAY, { smart: 25 })
    const res = await post(gw, token, { model: 'smart', input: 'hi' })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-faangin-mode'), 'fast')
    await res.text()
    assert.equal(fake.requests[0].body.model, MODELS.fast)
    assert.equal((await usage()).fast, 1)
    assert.equal((await usage()).smart, 25)
  })

  it('runs smart as fast on the smartToFast flag', async () => {
    gw.flags.smartToFast = true
    const res = await post(gw, token, { model: 'smart', input: 'hi' })
    assert.equal(res.headers.get('x-faangin-mode'), 'fast')
    await res.text()
    assert.equal(fake.requests[0].body.model, MODELS.fast)
  })

  it('answers 429 allowance_exhausted at the fast cap', async () => {
    await gw.store.increment(uid, PERIOD_KEY, TODAY, { fast: 500 })
    const res = await post(gw, token, { model: 'fast', input: 'hi' })
    assert.equal(res.status, 429)
    assert.deepEqual(await errorCode(res), { code: 'allowance_exhausted', allowance: 'fast', message: 'Allowance exhausted for this period' })
    assert.equal(fake.requests.length, 0)
  })

  it('a yearly Pro subscriber\'s allowance renews on the monthly anniversary of the yearly period', async () => {
    gw.entitlements.set(uid, proEntitlement({ priceLookupKey: 'faangin_pro_annual', currentPeriodEnd: Date.UTC(2027, 9, 1) }))
    await gw.store.increment(uid, PERIOD_KEY, TODAY, { fast: 500 })
    const exhausted = await post(gw, token, { model: 'fast', input: 'hi' })
    assert.equal(exhausted.status, 429, 'month one is used up')
    gw.clock.now = Date.UTC(2026, 10, 1, 0, 0, 1) // first monthly anniversary of the yearly period start
    const renewed = await post(gw, token, { model: 'fast', input: 'hi' })
    assert.equal(renewed.status, 200, 'month two starts with a fresh allowance, not a year later')
    await renewed.text()
    assert.equal((await gw.store.read(uid, String(Date.UTC(2026, 10, 1)))).fast, 1)
    assert.equal((await gw.store.read(uid, PERIOD_KEY)).fast, 500, 'month one\'s counters are untouched')
  })

  it('streams a synthetic response.completed for handsfree at its cap or when off, without calling upstream', async () => {
    await gw.store.increment(uid, PERIOD_KEY, TODAY, { handsfree: 1500 })
    const res = await post(gw, token, { model: 'handsfree', input: 'hi' })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    const events = parseSse(await res.text())
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'response.completed')
    const completed = events[0].data as { type: string; response: { output: unknown[]; usage: { input_tokens: number; output_tokens: number; total_tokens: number } } }
    assert.equal(completed.type, 'response.completed')
    assert.deepEqual(completed.response.output, [])
    assert.equal(completed.response.usage.input_tokens, 0)
    assert.equal(completed.response.usage.output_tokens, 0)
    assert.equal(completed.response.usage.total_tokens, 0)
    assert.equal(fake.requests.length, 0)
    assert.equal((await usage()).handsfree, 1500)

    gw.flags.handsfreeOff = true
    const uid2 = `${uid}b`
    gw.entitlements.set(uid2, proEntitlement())
    const res2 = await post(gw, `tok-${uid2}`, { model: 'handsfree', input: 'hi' })
    assert.equal(parseSse(await res2.text())[0].event, 'response.completed')
    assert.equal(fake.requests.length, 0)
  })

  it('allows two answers in flight and rejects the third with 429 concurrency', async () => {
    fake.hold = true
    const first = await post(gw, token, { model: 'fast', input: '1' })
    const second = await post(gw, token, { model: 'fast', input: '2' })
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    const third = await post(gw, token, { model: 'fast', input: '3' })
    assert.equal(third.status, 429)
    assert.equal((await errorCode(third)).code, 'concurrency')
    fake.release()
    await Promise.all([first.text(), second.text()])
    await until(async () => (await usage()).spendUsd > 0)
    fake.hold = false
    const fourth = await post(gw, token, { model: 'fast', input: '4' })
    assert.equal(fourth.status, 200)
    await fourth.text()
    assert.equal((await usage()).fast, 3)
  })

  it('caps at 30 % while the subscription is ramping', async () => {
    await gw.store.increment(uid, PERIOD_KEY, TODAY, { fast: 150 })
    gw.entitlements.set(uid, proEntitlement({ rampUntil: NOW + 1 }))
    const ramped = await post(gw, token, { model: 'fast', input: 'hi' })
    assert.equal(ramped.status, 429)
    assert.equal((await errorCode(ramped)).code, 'allowance_exhausted')
    gw.entitlements.set(uid, proEntitlement({ rampUntil: NOW }))
    const settled = await post(gw, token, { model: 'fast', input: 'hi' })
    assert.equal(settled.status, 200)
    await settled.text()
  })

  it('answers 429 backstop on month or day spend', async () => {
    await gw.store.increment(uid, PERIOD_KEY, TODAY, { spendUsd: 16 })
    const month = await post(gw, token, { model: 'fast', input: 'hi' })
    assert.equal(month.status, 429)
    assert.equal((await errorCode(month)).code, 'backstop')
    const uid2 = `${uid}b`
    gw.entitlements.set(uid2, proEntitlement())
    await gw.store.increment(uid2, PERIOD_KEY, TODAY, { spendUsd: 11 })
    const day = await post(gw, `tok-${uid2}`, { model: 'fast', input: 'hi' })
    assert.equal(day.status, 429)
    assert.equal(fake.requests.length, 0)
  })

  it('passes an upstream non-2xx through with its JSON', async () => {
    fake.next = { status: 400, body: { error: { message: 'bad input', type: 'invalid_request_error' } } }
    const res = await post(gw, token, { model: 'fast', input: 'hi' })
    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), { error: { message: 'bad input', type: 'invalid_request_error' } })
    assert.equal((await usage()).fast, 1)
    assert.equal((await usage()).spendUsd, 0)
  })
})
