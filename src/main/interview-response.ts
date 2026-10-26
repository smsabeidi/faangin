export type InterviewResponseDisposition = 'assist' | 'wait'

export class InterviewResponseProtocolError extends Error {
  readonly code = 'invalid_interview_response'
  constructor() { super('The automatic interview response did not use its expected reply format.'); this.name = 'InterviewResponseProtocolError' }
}

/** Strip one bounded decision line before any user-visible text; never buffer the answer. */
export class InterviewResponseDecoder {
  private prefix = ''
  private decision: InterviewResponseDisposition | null = null
  private bodyCharacters = 0
  private usefulBody = false
  private ended = false
  private invalid = false
  constructor(private readonly maxBodyCharacters = 128 * 1024) {
    if (!Number.isSafeInteger(maxBodyCharacters) || maxBodyCharacters < 1) throw new Error('The automatic response limit must be a positive whole character count.')
  }
  get disposition(): InterviewResponseDisposition | null { return this.decision }
  private fail(): never { this.invalid = true; throw new InterviewResponseProtocolError() }
  push(delta: string): string {
    if (this.ended || this.invalid || typeof delta !== 'string') return this.fail()
    let offset = 0
    while (!this.decision && offset < delta.length) {
      this.prefix += delta[offset++]
      const allowed = ['ASSIST\n', 'ASSIST\r\n', 'WAIT\n', 'WAIT\r\n']
      if (!allowed.some(header => header.startsWith(this.prefix))) return this.fail()
      if (this.prefix.endsWith('\n')) { this.decision = this.prefix.startsWith('ASSIST') ? 'assist' : 'wait'; this.prefix = '' }
    }
    if (!this.decision) return ''
    const body = delta.slice(offset)
    this.bodyCharacters += body.length
    if (this.bodyCharacters > this.maxBodyCharacters) return this.fail()
    if (this.decision === 'wait') { if (body.trim()) return this.fail(); return '' }
    this.usefulBody ||= !!body.trim()
    return body
  }
  finish(): InterviewResponseDisposition {
    if (this.invalid) return this.fail()
    if (this.ended) return this.decision!
    // A provider may omit the terminal newline when the complete response is only WAIT.
    if (!this.decision && this.prefix === 'WAIT') { this.decision = 'wait'; this.prefix = '' }
    if (!this.decision || (this.decision === 'assist' && !this.usefulBody)) return this.fail()
    this.ended = true
    return this.decision
  }
}
