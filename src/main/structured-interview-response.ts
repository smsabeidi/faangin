import { InterviewResponseDecoder, InterviewResponseProtocolError, type InterviewResponseDisposition } from './interview-response'

export const STRUCTURED_INTERVIEW_FORMAT = {
  type: 'json_schema',
  name: 'interview_reply',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      disposition: { type: 'string', enum: ['assist', 'wait'] },
      answer: { type: 'string' }
    },
    required: ['disposition', 'answer'],
    additionalProperties: false
  }
} as const

export function supportsStructuredInterviewReply(model: string): boolean {
  return model === 'gpt-6-luna' || model === 'gpt-6.1-sol'
}

type State = 'object' | 'dispositionKey' | 'dispositionKeyString' | 'dispositionColon' | 'dispositionValue'
  | 'dispositionString' | 'comma' | 'answerKey' | 'answerKeyString' | 'answerColon' | 'answerValue'
  | 'answerString' | 'closeObject' | 'done'
type Escape = 'backslash' | 'unicode' | null

const jsonWhitespace = (character: string): boolean => character === ' ' || character === '\t' || character === '\r' || character === '\n'
const stringEscapes: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

/** Decode only this ordered schema; retain bounded metadata and at most one answer surrogate between deltas. */
export class StructuredInterviewResponseDecoder {
  private state: State = 'object'
  private decision: InterviewResponseDisposition | null = null
  private metadataCharacters = 0
  private token = ''
  private escape: Escape = null
  private unicodeDigits = ''
  private pendingHighSurrogate = ''
  private bodyCharacters = 0
  private usefulBody = false
  private ended = false
  private invalid = false

  constructor(private readonly maxBodyCharacters = 128 * 1024) {
    if (!Number.isSafeInteger(maxBodyCharacters) || maxBodyCharacters < 1) throw new Error('The automatic response limit must be a positive whole character count.')
  }

  get disposition(): InterviewResponseDisposition | null { return this.decision }

  private fail(): never { this.invalid = true; throw new InterviewResponseProtocolError() }

  private answerCharacter(character: string): string {
    this.bodyCharacters += character.length
    if (this.bodyCharacters > this.maxBodyCharacters) return this.fail()
    this.usefulBody ||= !!character.trim()
    if (this.decision === 'wait') {
      if (character.trim()) return this.fail()
      return ''
    }
    // A provider delta may split a literal or escaped UTF-16 pair. Keep the pair in one output delta.
    const preceding = this.pendingHighSurrogate
    this.pendingHighSurrogate = ''
    const code = character.charCodeAt(0)
    if (code >= 0xd800 && code <= 0xdbff) {
      this.pendingHighSurrogate = character
      return preceding
    }
    return preceding + character
  }

  private stringCharacter(character: string): string {
    let decoded: string
    if (this.escape === 'unicode') {
      if (!/^[0-9a-fA-F]$/.test(character)) return this.fail()
      this.unicodeDigits += character
      if (this.unicodeDigits.length < 4) return ''
      decoded = String.fromCharCode(Number.parseInt(this.unicodeDigits, 16))
      this.unicodeDigits = ''
      this.escape = null
    } else if (this.escape === 'backslash') {
      if (character === 'u') { this.escape = 'unicode'; return '' }
      if (!Object.hasOwn(stringEscapes, character)) return this.fail()
      decoded = stringEscapes[character]
      this.escape = null
    } else {
      if (character === '\\') { this.escape = 'backslash'; return '' }
      if (character === '"') return this.closeString()
      if (character.charCodeAt(0) < 0x20) return this.fail()
      decoded = character
    }
    if (this.state === 'answerString') return this.answerCharacter(decoded)
    this.token += decoded
    const expected = this.state === 'dispositionKeyString' ? ['disposition'] : this.state === 'answerKeyString' ? ['answer'] : ['assist', 'wait']
    if (!expected.some(value => value.startsWith(this.token))) return this.fail()
    return ''
  }

  private closeString(): string {
    if (this.state === 'answerString') {
      this.state = 'closeObject'
      const remaining = this.pendingHighSurrogate
      this.pendingHighSurrogate = ''
      return remaining
    }
    if (this.state === 'dispositionKeyString' && this.token === 'disposition') this.state = 'dispositionColon'
    else if (this.state === 'answerKeyString' && this.token === 'answer') this.state = 'answerColon'
    else if (this.state === 'dispositionString' && (this.token === 'assist' || this.token === 'wait')) {
      this.decision = this.token
      this.state = 'comma'
    } else return this.fail()
    this.token = ''
    return ''
  }

  push(delta: string): string {
    if (this.ended || this.invalid || typeof delta !== 'string') return this.fail()
    let output = ''
    for (let offset = 0; offset < delta.length; offset++) {
      const character = delta[offset]
      // Both answer quotes and all surrounding syntax count against the metadata bound.
      if (this.state !== 'answerString' || (!this.escape && character === '"')) {
        if (++this.metadataCharacters > 512) return this.fail()
      }
      if (this.state === 'dispositionKeyString' || this.state === 'answerKeyString' || this.state === 'dispositionString' || this.state === 'answerString') {
        output += this.stringCharacter(character)
        continue
      }
      if (jsonWhitespace(character)) continue
      switch (this.state) {
        case 'object': if (character !== '{') return this.fail(); this.state = 'dispositionKey'; break
        case 'dispositionKey': if (character !== '"') return this.fail(); this.state = 'dispositionKeyString'; break
        case 'dispositionColon': if (character !== ':') return this.fail(); this.state = 'dispositionValue'; break
        case 'dispositionValue': if (character !== '"') return this.fail(); this.state = 'dispositionString'; break
        case 'comma': if (character !== ',') return this.fail(); this.state = 'answerKey'; break
        case 'answerKey': if (character !== '"') return this.fail(); this.state = 'answerKeyString'; break
        case 'answerColon': if (character !== ':') return this.fail(); this.state = 'answerValue'; break
        case 'answerValue': if (character !== '"') return this.fail(); this.state = 'answerString'; break
        case 'closeObject': if (character !== '}') return this.fail(); this.state = 'done'; break
        default: return this.fail()
      }
    }
    return output
  }

  finish(): InterviewResponseDisposition {
    if (this.invalid) return this.fail()
    if (this.ended) return this.decision!
    if (this.state !== 'done' || !this.decision || (this.decision === 'assist' && !this.usefulBody)) return this.fail()
    this.ended = true
    return this.decision
  }
}

export function createInterviewResponseDecoder(protocol?: 'json'): InterviewResponseDecoder | StructuredInterviewResponseDecoder {
  return protocol === 'json' ? new StructuredInterviewResponseDecoder() : new InterviewResponseDecoder()
}
