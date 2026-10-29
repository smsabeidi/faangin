/** Pro gateway constants. Printed allowances come from the adopted Pro Option 1 (27 Oct 2026). */
export const PORT = Number(process.env.PORT ?? 8080)
export const OPENAI_BASE = process.env.OPENAI_BASE ?? 'https://api.openai.com'
export const OPENAI_WS_BASE = process.env.OPENAI_WS_BASE ?? 'wss://api.openai.com'

/** Models are fixed server-side; the client only names a mode. */
export const MODELS = {
  fast: process.env.FAST_MODEL ?? 'gpt-6-luna',
  smart: process.env.SMART_MODEL ?? 'gpt-6.1-sol',
  handsfree: process.env.FAST_MODEL ?? 'gpt-6-luna',
  transcribe: process.env.TRANSCRIBE_MODEL ?? 'gpt-transcribe'
} as const
export type Mode = 'fast' | 'smart' | 'handsfree'

/** Per allowance month (the Stripe billing period). Each stops at its count. */
export const ALLOWANCES = {
  audioSeconds: 20 * 3600,       // 20 h of transcribed audio
  audioSecondsPerDay: 5 * 3600,  // 5 h a day
  handsfree: 1500,
  fast: 500,
  smart: 25
} as const
/** First 14 days of a subscription (and after a refund/dispute/new card) allow 30% of each. */
export const RAMP_FRACTION = 0.3
/** Once per allowance month a session at a listening/hands-free limit keeps going for 30 minutes. */
export const GRACE_SECONDS = 30 * 60
/** Hidden spend backstops on estimated provider cost, in USD. */
export const BACKSTOP_USD = { month: 16, day: 11 } as const

/** Per-request token caps. The app trims below these, so customers never see a refusal. */
export const CAPS = {
  fast: { input: 16_000, output: 4_096 },
  smart: { input: 24_000, output: 4_096 },
  handsfree: { input: 10_000, output: 300 }
} as const

/** USD per 1M tokens; audio per hour. Used only for the backstop estimate, never for billing. */
export const PRICES = {
  fast: { input: 0.4, cachedInput: 0.1, output: 1.6 },
  smart: { input: 2, cachedInput: 0.5, output: 8 },
  transcribeAudioPerHour: 0.27
} as const

export const MAX_CONCURRENT_ANSWERS = 2
export const MAX_LIVE_SESSIONS = 1
export const ENTITLEMENT_CACHE_MS = 30_000
export const SOCKET_IDLE_CLOSE_MS = 30 * 60 * 1000
/** pcm16 mono at 24 kHz: bytes per second of audio. */
export const PCM_BYTES_PER_SECOND = 24_000 * 2
