import assert from 'node:assert/strict'
import test from 'node:test'
import { InterviewResponseDecoder, InterviewResponseProtocolError } from '../src/main/interview-response'

test('every fragmented LF/CRLF header strips only the protocol and preserves useful answer text', () => {
  for (const newline of ['\n', '\r\n']) {
    const body = 'BFS visits by distance.\n```python\nqueue.append(node)\n```\n🧠 O(V + E).'
    const response = `ASSIST${newline}${body}`
    for (let cut = 0; cut <= response.length; cut++) {
      const decoder = new InterviewResponseDecoder()
      const output = decoder.push(response.slice(0, cut)) + decoder.push(response.slice(cut))
      assert.equal(output, body, `split ${cut}`)
      assert.equal(decoder.disposition, 'assist')
      assert.equal(decoder.finish(), 'assist')
    }
  }
})

test('header decision is unavailable until its full line and code at the start of the body is untouched', () => {
  const decoder = new InterviewResponseDecoder()
  for (const character of 'ASSIST\r') { assert.equal(decoder.push(character), ''); assert.equal(decoder.disposition, null) }
  assert.equal(decoder.push('\n'), ''); assert.equal(decoder.disposition, 'assist')
  const code = '```python\nprint("WAIT")\n```'
  assert.equal(decoder.push(code), code)
  assert.equal(decoder.finish(), 'assist')
  assert.equal(decoder.finish(), 'assist')
})

test('WAIT suppresses all deltas, accepts fragmented CRLF and tolerates only trailing whitespace', () => {
  for (const response of ['WAIT\n', 'WAIT\r\n', 'WAIT\n \t\r\n', 'WAIT']) {
    for (let cut = 0; cut <= response.length; cut++) {
      const decoder = new InterviewResponseDecoder()
      assert.equal(decoder.push(response.slice(0, cut)) + decoder.push(response.slice(cut)), '')
      assert.equal(decoder.finish(), 'wait')
    }
  }
  const decoder = new InterviewResponseDecoder()
  assert.equal(decoder.push('WAIT\n'), '')
  assert.throws(() => decoder.push('Here is why I waited.'), InterviewResponseProtocolError)
})

test('malformed, ambiguous, fenced or incomplete decisions fail without emitting their prefix', () => {
  for (const response of [' ASSIST\nAnswer', '\ufeffASSIST\nAnswer', '```\nASSIST\nAnswer', 'assist\nAnswer', 'ASSISTANCE\nAnswer', 'ASSIST: answer', 'WAIT\nASSIST\nAnswer', 'WAITING\n', 'ASSIST\rAnswer']) {
    const decoder = new InterviewResponseDecoder(); let emitted = ''
    assert.throws(() => { emitted += decoder.push(response); decoder.finish() }, InterviewResponseProtocolError)
    assert.equal(emitted, '')
  }
  for (const response of ['', 'AS', 'ASSIST', 'ASSIST\r', 'ASSIST\n', 'ASSIST\n   ', 'WAIT\r']) {
    const decoder = new InterviewResponseDecoder()
    decoder.push(response)
    assert.throws(() => decoder.finish(), InterviewResponseProtocolError)
  }
})

test('prefix and body work remain bounded and invalid or finished decoders cannot resume', () => {
  const oversizedPrefix = new InterviewResponseDecoder()
  assert.throws(() => oversizedPrefix.push('A'.repeat(100_000)), InterviewResponseProtocolError)
  assert.throws(() => oversizedPrefix.push('ASSIST\nAnswer'), InterviewResponseProtocolError)
  assert.throws(() => oversizedPrefix.finish(), InterviewResponseProtocolError)
  const outputLimit = new InterviewResponseDecoder(3)
  assert.equal(outputLimit.push('ASSIST\nabc'), 'abc')
  assert.throws(() => outputLimit.push('d'), InterviewResponseProtocolError)
  const done = new InterviewResponseDecoder(); done.push('WAIT\n'); done.finish()
  assert.throws(() => done.push(''), InterviewResponseProtocolError)
  for (const limit of [0, -1, Infinity, 1.5]) assert.throws(() => new InterviewResponseDecoder(limit), /positive whole/)
})
