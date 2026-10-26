import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyConfiguredModels } from '../src/main/inference'
import { DEFAULT_SETTINGS } from '../src/shared/types'

test('connection checks verify all configured models using GET without generation or exposing credentials', async () => {
  const urls: string[] = []
  const result = await verifyConfiguredModels('fixture-not-a-real-key', DEFAULT_SETTINGS, { fetch: (async (url, init) => {
    urls.push(String(url)); assert.equal(init?.body, undefined); assert.equal(init?.method, undefined)
    assert(String(url).includes('/v1/models/'))
    return Response.json({ id: 'accessible' })
  }) as typeof fetch })
  assert(result.ok); assert.equal(urls.length, 3); assert.equal(result.checks?.length, 3)
  assert(result.message.includes('quota')); assert(!JSON.stringify(result).includes('fixture-not-a-real-key'))
})

test('model verification reports individual failures without hiding usable models', async () => {
  const result = await verifyConfiguredModels('fixture-not-a-real-key', DEFAULT_SETTINGS, { fetch: (async url => String(url).endsWith('gpt-4.1') ? Response.json({ error: { code: 'permission_denied', message: 'fixture-not-a-real-key must never be exposed' } }, { status: 403 }) : Response.json({ id: 'available' })) as typeof fetch })
  assert(!result.ok)
  assert.deepEqual(result.checks?.map(check => check.ok), [true, false, true])
  assert(result.checks?.[1].message.includes('permission'))
  assert(!JSON.stringify(result).includes('fixture-not-a-real-key'))
})

test('the same configured model is checked once and yields a result for both labels', async () => {
  let requests = 0
  const result = await verifyConfiguredModels('fixture-not-a-real-key', { ...DEFAULT_SETTINGS, smartModel: DEFAULT_SETTINGS.fastModel }, { fetch: (async () => { requests++; return Response.json({ id: 'available' }) }) as typeof fetch })
  assert(result.ok); assert.equal(requests, 2); assert.equal(result.checks?.length, 3)
})
