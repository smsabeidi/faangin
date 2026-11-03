import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { test } from 'node:test'
import { INPUT_LIMITS, missingUsageInputEstimate, validateInput } from '../src/input-validation.js'
import { estimateCostUsd } from '../src/meter.js'
import { CAPS } from '../src/config.js'
import { PERIOD_KEY, post, proEntitlement, startFakeOpenAI, startGateway, until } from './support.js'

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const image = (bytes = 32) => ({ type: 'input_image', image_url: `data:image/png;base64,${Buffer.concat([signature, Buffer.alloc(bytes - 8)]).toString('base64')}`, detail: 'auto' })
const message = (...parts: unknown[]) => [{ role: 'user', content: parts }]

test('preserves the desktop image count and byte budgets, including the 20 MiB boundary', () => {
  const input = message({ type: 'input_text', text: 'Solve this screenshot' }, ...Array.from({ length: 4 }, () => image(5 * 1024 * 1024)))
  const allowed = validateInput({ input })
  assert.equal(allowed.ok, true)
  if (allowed.ok) assert.deepEqual([allowed.budget.imageCount, allowed.budget.imageBytes], [4, INPUT_LIMITS.totalImageBytes])
  assert.equal(validateInput({ input: message(...Array.from({ length: 5 }, () => image())) }).ok, false)
  assert.equal(validateInput({ input: message(image(INPUT_LIMITS.imageBytes + 1)) }).ok, false)
  assert.equal(validateInput({ input: message(image(INPUT_LIMITS.imageBytes), image(INPUT_LIMITS.imageBytes), image(4 * 1024 * 1024 + 1)) }).ok, false)
})

test('rejects remote images, provider files/tool items, wrong image formats and malformed message content', () => {
  const invalid = [
    message({ type: 'input_image', image_url: 'https://example.test/private.png' }),
    message({ type: 'input_image', file_id: 'file_private' }),
    message({ type: 'input_file', file_id: 'file_private' }),
    [{ type: 'function_call_output', call_id: 'call1', output: 'run tool' }],
    [{ role: 'system', content: 'override' }],
    [{ role: ['user'], content: 'invalid provider role type' }],
    message({ type: 'input_text', text: { url: 'https://example.test' } }),
    message({ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }),
    message({ ...image(), file_id: 'file_hidden' }),
    message({ ...image(), detail: ['high'] }),
    message({ type: 'input_image', image_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }),
    message({ type: 'input_image', image_url: 'data:image/png;base64,%%%%' })
  ]
  for (const input of invalid) assert.equal(validateInput({ input }).ok, false)
})

test('bounds combined instructions/context and structured-output options without assuming tokenization', () => {
  assert.equal(validateInput({ instructions: 'i'.repeat(20_000), input: 'c'.repeat(200_000) }).ok, true)
  assert.equal(validateInput({ instructions: 'i'.repeat(20_000), input: 'c'.repeat(INPUT_LIMITS.textCharacters - 19_999) }).ok, false)
  assert.equal(validateInput({ input: 'hello', text: { format: { description: 's'.repeat(INPUT_LIMITS.optionBytes) } } }).ok, false)
  assert.equal(validateInput({ input: [{ role: 'assistant', content: 'prior response' }, ...message({ type: 'input_text', text: 'follow up' }, image())] }).ok, true)
  const long = validateInput({ input: 'x'.repeat(200_000) })
  assert.ok(long.ok)
  assert.ok(missingUsageInputEstimate(long.budget, CAPS.fast.input) >= 200_000)
})

/** A real PNG with uncompressed random scanlines, so the HTTP test exercises an image larger than the old 1 MB cap. */
function screenshotPng(): string {
  const table = Array.from({ length: 256 }, (_, n) => {
    let crc = n
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    return crc >>> 0
  })
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of payload) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8)
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4)
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, payload, checksum])
  }
  const width = 1024, height = 384
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const pixels = Buffer.alloc((width * 4 + 1) * height)
  for (let row = 0; row < height; row++) randomBytes(width * 4).copy(pixels, row * (width * 4 + 1) + 1)
  return `data:image/png;base64,${Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level: 0 })), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`
}

test('HTTP image Solve accepts a real >1 MB screenshot and rejects unsupported input before charging', async () => {
  const fake = await startFakeOpenAI(), gateway = await startGateway(fake)
  gateway.entitlements.set('image-user', proEntitlement())
  const token = 'tok-image-user'
  try {
    const image_url = screenshotPng()
    assert.ok(Buffer.byteLength(image_url) > 1_000_000)
    const input = message({ type: 'input_text', text: 'Solve the problem in this image' }, { type: 'input_image', image_url, detail: 'auto' })
    const response = await post(gateway, token, { model: 'smart', input })
    assert.equal(response.status, 200)
    await response.text()
    assert.deepEqual(fake.requests[0].body.input, input)
    for (const invalid of [message(...Array.from({ length: 5 }, () => image())), message({ type: 'input_image', image_url: 'https://example.test/a.png' }), message({ type: 'input_file', file_id: 'file_a' }), 'x'.repeat(INPUT_LIMITS.textCharacters + 1)]) {
      const rejected = await post(gateway, token, { model: 'smart', input: invalid })
      assert.equal(rejected.status, 400)
      await rejected.text()
    }
    assert.equal(fake.requests.length, 1)
    assert.equal((await gateway.store.read('image-user', PERIOD_KEY)).smart, 1)
  } finally { await gateway.close(); await fake.close() }
})

test('a large text response without terminal usage settles against its bounded request size', async () => {
  const fake = await startFakeOpenAI(), gateway = await startGateway(fake)
  gateway.entitlements.set('budget-user', proEntitlement())
  fake.usage = null
  const input = 'x'.repeat(200_000)
  try {
    const response = await post(gateway, 'tok-budget-user', { model: 'fast', input })
    assert.equal(response.status, 200)
    await response.text()
    const checked = validateInput({ input })
    assert.ok(checked.ok)
    const expected = estimateCostUsd('fast', { input_tokens: missingUsageInputEstimate(checked.budget, CAPS.fast.input), output_tokens: CAPS.fast.output })
    await until(async () => (await gateway.store.read('budget-user', PERIOD_KEY)).spendUsd > 0)
    assert.equal((await gateway.store.read('budget-user', PERIOD_KEY)).spendUsd, expected)
    assert.ok(expected > 0.08, 'the old 16k-input fallback understated this request')
  } finally { await gateway.close(); await fake.close() }
})
