/** Desktop-compatible request bounds. These are character/byte limits, not a model tokenizer. */
import { Buffer } from 'node:buffer'

export const INPUT_LIMITS = {
  bodyBytes: 32 * 1024 * 1024,
  textCharacters: 256_000,
  textBytes: 1024 * 1024,
  optionBytes: 64 * 1024,
  messages: 32,
  partsPerMessage: 32,
  images: 4,
  imageBytes: 8 * 1024 * 1024,
  totalImageBytes: 20 * 1024 * 1024
} as const

export interface InputBudget { textBytes: number; imageCount: number; imageBytes: number }
export type InputValidation = { ok: true; budget: InputBudget } | { ok: false; message: string }
type Json = Record<string, unknown>
const record = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const only = (value: Json, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))

/** Accept only the text/messages/images produced by the app. Provider files, tools and remote fetches are excluded. */
export function validateInput(body: Json): InputValidation {
  const budget: InputBudget = { textBytes: 0, imageCount: 0, imageBytes: 0 }
  let characters = 0
  const text = (value: unknown): boolean => {
    if (typeof value !== 'string') return false
    characters += value.length
    budget.textBytes += Buffer.byteLength(value, 'utf8')
    return characters <= INPUT_LIMITS.textCharacters && budget.textBytes <= INPUT_LIMITS.textBytes
  }
  const fail = (message: string): InputValidation => ({ ok: false, message })
  if (body.instructions !== undefined && !text(body.instructions)) return fail('Instructions and context exceed the text budget or are not text')
  if (body.prompt_cache_key !== undefined && (typeof body.prompt_cache_key !== 'string' || body.prompt_cache_key.length > 512)) return fail('Invalid prompt cache key')
  if (body.truncation !== undefined && body.truncation !== 'auto' && body.truncation !== 'disabled') return fail('Invalid truncation setting')
  // A structured-output schema can carry provider-visible descriptions. Bound it with the rest of the text budget.
  for (const field of ['reasoning', 'text'] as const) {
    if (body[field] === undefined) continue
    if (!record(body[field])) return fail(`Invalid ${field} options`)
    const serialized = JSON.stringify(body[field])
    if (Buffer.byteLength(serialized) > INPUT_LIMITS.optionBytes || !text(serialized)) return fail(`${field} options exceed the text budget`)
  }

  const image = (part: Json): boolean => {
    if (!only(part, ['type', 'image_url', 'detail']) || typeof part.image_url !== 'string') return false
    if (part.detail !== undefined && (typeof part.detail !== 'string' || !['auto', 'low', 'high'].includes(part.detail))) return false
    // Bound the encoded string before decoding it. Never accept an HTTP URL or a provider file id.
    if (part.image_url.length > Math.ceil(INPUT_LIMITS.imageBytes / 3) * 4 + 64) return false
    const comma = part.image_url.indexOf(',')
    const mime = part.image_url.slice(0, comma)
    if (!['data:image/png;base64', 'data:image/jpeg;base64', 'data:image/webp;base64'].includes(mime)) return false
    const encoded = part.image_url.slice(comma + 1)
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return false
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length > INPUT_LIMITS.imageBytes) return false
    const matches = mime === 'data:image/png;base64' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === 'data:image/jpeg;base64' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    if (!matches) return false
    budget.imageCount++
    budget.imageBytes += bytes.length
    return budget.imageCount <= INPUT_LIMITS.images && budget.imageBytes <= INPUT_LIMITS.totalImageBytes
  }

  if (typeof body.input === 'string') {
    if (!body.input || !text(body.input)) return fail('Input exceeds the text budget or is empty')
  } else {
    if (!Array.isArray(body.input) || !body.input.length || body.input.length > INPUT_LIMITS.messages) return fail('Input must be text or at most 32 messages')
    for (const message of body.input) {
      if (!record(message) || !only(message, ['type', 'role', 'content']) || (message.type !== undefined && message.type !== 'message') || typeof message.role !== 'string' || !['user', 'assistant'].includes(message.role)) return fail('Only user and assistant text/image messages are supported')
      if (typeof message.content === 'string') {
        if (!message.content || !text(message.content)) return fail('Message text exceeds the context budget or is empty')
        continue
      }
      if (!Array.isArray(message.content) || !message.content.length || message.content.length > INPUT_LIMITS.partsPerMessage) return fail('Invalid message content')
      for (const part of message.content) {
        if (!record(part)) return fail('Invalid message content')
        if (part.type === 'input_text' && only(part, ['type', 'text']) && text(part.text)) continue
        if (part.type === 'input_image' && message.role === 'user' && image(part)) continue
        return fail('Use bounded text and at most four PNG, JPEG or WebP data images (8 MiB each, 20 MiB total)')
      }
    }
  }
  // Cover message framing and option overhead in a missing-usage fallback without counting base64 as text tokens.
  budget.textBytes += (Array.isArray(body.input) ? body.input.length : 1) * 128 + 1024
  if (budget.textBytes > INPUT_LIMITS.textBytes) return fail('Context exceeds the UTF-8 text budget')
  return { ok: true, budget }
}

/**
 * Without a terminal usage event, use UTF-8 bytes as a deliberately conservative text token estimate and a large,
 * fixed image reserve. Image tokenization depends on the server model; this is a backstop estimate, never an invoice.
 */
export function missingUsageInputEstimate(budget: InputBudget, baseline: number): number {
  return Math.max(baseline, budget.textBytes + budget.imageCount * 1_000_000)
}
