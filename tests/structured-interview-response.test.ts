import assert from 'node:assert/strict'
import test from 'node:test'
import { InterviewResponseDecoder, InterviewResponseProtocolError } from '../src/main/interview-response'
import {
  STRUCTURED_INTERVIEW_FORMAT,
  StructuredInterviewResponseDecoder,
  createInterviewResponseDecoder,
  supportsStructuredInterviewReply
} from '../src/main/structured-interview-response'

const reply = (answer: string, disposition: 'assist' | 'wait' = 'assist'): string => JSON.stringify({ disposition, answer })

function checkEveryFragmentation(wire: string, answer: string, disposition: 'assist' | 'wait' = 'assist'): void {
  for (let cut = 0; cut <= wire.length; cut++) {
    const decoder = new StructuredInterviewResponseDecoder()
    const output = decoder.push(wire.slice(0, cut)) + decoder.push(wire.slice(cut))
    assert.equal(output, answer, `split ${cut} of ${wire}`)
    assert.equal(decoder.disposition, disposition)
    assert.equal(decoder.finish(), disposition)
    assert.equal(decoder.finish(), disposition)
  }
  const decoder = new StructuredInterviewResponseDecoder()
  let output = ''
  for (const character of wire.split('')) output += decoder.push(character)
  assert.equal(output, answer, `character stream of ${wire}`)
  assert.equal(decoder.finish(), disposition)
}

test('strict Responses schema orders the decision before the streamed answer and allows no other properties', () => {
  assert.deepEqual(STRUCTURED_INTERVIEW_FORMAT, {
    type: 'json_schema', name: 'interview_reply', strict: true,
    schema: {
      type: 'object',
      properties: { disposition: { type: 'string', enum: ['assist', 'wait'] }, answer: { type: 'string' } },
      required: ['disposition', 'answer'], additionalProperties: false
    }
  })
  assert.deepEqual(Object.keys(STRUCTURED_INTERVIEW_FORMAT.schema.properties), ['disposition', 'answer'])
})

test('only the two approved exact model IDs select structured replies and the factory preserves legacy decoding', () => {
  for (const model of ['gpt-6-luna', 'gpt-6.1-sol']) assert.equal(supportsStructuredInterviewReply(model), true)
  for (const model of ['', 'gpt-6', 'gpt-6-sol', 'gpt-6.1', 'gpt-6.1-luna', 'gpt-6.1-sol-2026-10-01', ' gpt-6-luna', 'gpt-6-luna ', 'GPT-6-LUNA', 'openai/gpt-6-luna']) {
    assert.equal(supportsStructuredInterviewReply(model), false, model)
  }
  const legacy = createInterviewResponseDecoder()
  assert.ok(legacy instanceof InterviewResponseDecoder)
  assert.equal(legacy.push('ASSIST\nA legacy answer.'), 'A legacy answer.')
  assert.equal(legacy.finish(), 'assist')
  const structured = createInterviewResponseDecoder('json')
  assert.ok(structured instanceof StructuredInterviewResponseDecoder)
  assert.equal(structured.push(reply('A structured answer.')), 'A structured answer.')
  assert.equal(structured.finish(), 'assist')
})

test('every split and character stream preserves escaped code, negation, numeric values, and Unicode', () => {
  for (const answer of [
    'I would not remove the check: x != null and count !== 0. It is not O(n²).',
    'Costs: O(V + E), -42, 0, 0.125, 1e-3, 9_000 and 100%. Do not change them.',
    '```python\nif path != "C:\\temp":\n    print("WAIT", {"k": [1, 2]})\n```\nDo not return early.',
    'Unicode: 🧠, 😀, café, 中文, \u2028, \u2029, combining e\u0301.',
    '\"\\/\b\f\n\r\t\u0000\u001f final.'
  ]) checkEveryFragmentation(reply(answer), answer)
})

test('all JSON escapes and upper/lowercase hex digits decode across every boundary', () => {
  const wire = String.raw`{"disposition":"assist","answer":"\"\\\/\b\f\n\r\t\u0000\u001F\u0061\u00e9\uD83e\uDdE0"}`
  checkEveryFragmentation(wire, '"\\/\b\f\n\r\t\u0000\u001faé🧠')
  checkEveryFragmentation(String.raw`{"disposi\u0074ion":"\u0061ssist","answ\u0065r":"yes"}`, 'yes')
})

test('schema whitespace is accepted at every token boundary while answer whitespace is preserved', () => {
  const wire = ' \r\n{\t"disposition" \n: \r"assist"\t,\n "answer"\t: \n"  keep me  " \r}\n\t '
  checkEveryFragmentation(wire, '  keep me  ')
  for (const whitespace of ['\v', '\f', '\u00a0', '\ufeff']) {
    const decoder = new StructuredInterviewResponseDecoder()
    assert.throws(() => decoder.push(whitespace + reply('Useful answer.')), InterviewResponseProtocolError)
  }
})

test('the disposition and answer are available before the closing string or object arrives', () => {
  const decoder = new StructuredInterviewResponseDecoder()
  assert.equal(decoder.push('{"disposition":"assis'), '')
  assert.equal(decoder.disposition, null)
  assert.equal(decoder.push('t"'), '')
  assert.equal(decoder.disposition, 'assist')
  assert.equal(decoder.push(',"answer":"First answer bytes'), 'First answer bytes')
  assert.equal(decoder.push(' arrive now.'), ' arrive now.')
  assert.equal(decoder.push('"'), '')
  assert.equal(decoder.push('}'), '')
  assert.equal(decoder.finish(), 'assist')
})

test('split literal and escaped surrogate pairs are emitted together without buffering the answer', () => {
  const literal = new StructuredInterviewResponseDecoder()
  assert.equal(literal.push('{"disposition":"assist","answer":"hello '), 'hello ')
  assert.equal(literal.push('\ud83e'), '')
  assert.equal(literal.push('\udde0'), '🧠')
  assert.equal(literal.push(' world"}'), ' world')
  assert.equal(literal.finish(), 'assist')
  const escaped = new StructuredInterviewResponseDecoder()
  assert.equal(escaped.push(String.raw`{"disposition":"assist","answer":"\uD83E`), '')
  assert.equal(escaped.push(String.raw`\uDDE0`), '🧠')
  assert.equal(escaped.push('"}'), '')
  assert.equal(escaped.finish(), 'assist')
  // JSON permits unpaired UTF-16 code units; keep the same string semantics as JSON.parse.
  for (const answer of ['\ud800x', 'x\udfff', '\ud800', '\ud800\ud800']) checkEveryFragmentation(reply(answer), answer)
})

test('WAIT suppresses every delta and accepts only an empty or decoded whitespace answer', () => {
  for (const answer of ['', ' \t\r\n', '\f\v\u00a0\ufeff']) checkEveryFragmentation(reply(answer, 'wait'), '', 'wait')
  const decoder = new StructuredInterviewResponseDecoder()
  assert.equal(decoder.push('{"disposition":"wait"'), '')
  assert.equal(decoder.disposition, 'wait')
  assert.equal(decoder.push(',"answer":"  '), '')
  assert.throws(() => decoder.push(String.raw`\u0041`), InterviewResponseProtocolError)
  for (const answer of ['ASSIST', 'Why I am waiting.', '\u0000', '\b', '🧠']) {
    const invalid = new StructuredInterviewResponseDecoder()
    assert.throws(() => invalid.push(reply(answer, 'wait')), InterviewResponseProtocolError)
  }
})

test('empty and whitespace-only assist answers fail at finish', () => {
  for (const answer of ['', ' \t\r\n', '\u00a0\ufeff']) {
    const decoder = new StructuredInterviewResponseDecoder()
    assert.equal(decoder.push(reply(answer)), answer)
    assert.throws(() => decoder.finish(), InterviewResponseProtocolError)
  }
})

test('missing, extra, repeated, reversed and mistyped fields and invalid decisions fail closed', () => {
  for (const wire of [
    '{}', '{"disposition":"assist"}', '{"answer":"yes","disposition":"assist"}',
    '{"disposition":"assist","answer":"yes","extra":true}',
    '{"disposition":"assist","answer":"yes","answer":"again"}',
    '{"disposition":"assist","disposition":"wait","answer":"yes"}',
    '{"disposition":"assist","answer":"yes",}',
    '{"disposition":"assist",,"answer":"yes"}',
    '{"disposition":"ASSIST","answer":"yes"}', '{"disposition":"waiting","answer":""}',
    '{"disposition":"","answer":"yes"}', '{"disposition":null,"answer":"yes"}',
    '{"disposition":true,"answer":"yes"}', '{"disposition":1,"answer":"yes"}',
    '{"disposition":"assist","answer":null}', '{"disposition":"assist","answer":false}',
    '{"disposition":"assist","answer":42}', '{"disposition":"assist","answer":{}}',
    '{"disposition":"assist","answer":[]}', '{disposition:"assist",answer:"yes"}'
  ]) {
    const decoder = new StructuredInterviewResponseDecoder()
    assert.throws(() => { decoder.push(wire); decoder.finish() }, InterviewResponseProtocolError, wire)
  }
})

test('raw controls and invalid escapes are rejected inside strings, even when fragmented', () => {
  const prefix = '{"disposition":"assist","answer":"'
  const invalidBodies = ['\\x41', '\\a', '\\U0041', '\\uZZZZ', '\\u12x4', '\\u000g', ...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code))]
  for (const body of invalidBodies) {
    const wire = prefix + body + '"}'
    for (let cut = 0; cut <= wire.length; cut++) {
      const decoder = new StructuredInterviewResponseDecoder()
      assert.throws(() => { decoder.push(wire.slice(0, cut)); decoder.push(wire.slice(cut)); decoder.finish() }, InterviewResponseProtocolError, JSON.stringify(wire))
    }
  }
})

test('refusals, prose, fences, legacy headers, and trailing JSON or text never count as a structured reply', () => {
  for (const wire of [
    'I cannot answer that.', 'ASSIST\nUseful answer.', 'WAIT', '```json\n' + reply('Useful answer.') + '\n```',
    '{"refusal":"I cannot assist."}', '[{"disposition":"assist","answer":"yes"}]',
    reply('Useful answer.') + 'false', reply('Useful answer.') + '{}', reply('Useful answer.') + ' trailing'
  ]) {
    const decoder = new StructuredInterviewResponseDecoder()
    assert.throws(() => { decoder.push(wire); decoder.finish() }, InterviewResponseProtocolError, wire)
  }
  const decoder = new StructuredInterviewResponseDecoder()
  assert.equal(decoder.push('{"disposition":"assist","answer":"Streaming first.'), 'Streaming first.')
  assert.throws(() => decoder.push('"} unexpected'), InterviewResponseProtocolError)
})

test('every incomplete prefix, including split escapes and object suffixes, fails at finish', () => {
  for (const wire of [reply('Useful answer.'), String.raw`{"disposition":"assist","answer":"\uD83E\uDDE0\n\""}`, reply('', 'wait')]) {
    for (let cut = 0; cut < wire.length; cut++) {
      const decoder = new StructuredInterviewResponseDecoder()
      decoder.push(wire.slice(0, cut))
      assert.throws(() => decoder.finish(), InterviewResponseProtocolError, `truncated at ${cut} of ${wire}`)
    }
  }
})

test('metadata is capped at exactly 512 raw characters and answer bytes do not consume that bound', () => {
  const wire = reply('', 'wait')
  const padding = ' '.repeat(512 - wire.length)
  const boundary = new StructuredInterviewResponseDecoder()
  assert.equal(boundary.push(padding + wire), '')
  assert.equal(boundary.finish(), 'wait')
  const oversized = new StructuredInterviewResponseDecoder()
  assert.throws(() => oversized.push(padding + ' ' + wire), InterviewResponseProtocolError)
  const trailing = new StructuredInterviewResponseDecoder()
  trailing.push(wire + padding)
  assert.throws(() => trailing.push(' '), InterviewResponseProtocolError)
  const leading = new StructuredInterviewResponseDecoder()
  assert.throws(() => leading.push(' '.repeat(100_000)), InterviewResponseProtocolError)
  const longAnswer = 'a'.repeat(10_000)
  const streaming = new StructuredInterviewResponseDecoder()
  streaming.push('{"disposition":"assist","answer":"')
  for (let index = 0; index < 10; index++) assert.equal(streaming.push(longAnswer), longAnswer)
  assert.equal(streaming.push('"}'), '')
  assert.equal(streaming.finish(), 'assist')
})

test('decoded answer limits include escaped characters and WAIT whitespace; invalid decoders cannot resume', () => {
  const exact = new StructuredInterviewResponseDecoder(3)
  assert.equal(exact.push(String.raw`{"disposition":"assist","answer":"\u0061bc"}`), 'abc')
  assert.equal(exact.finish(), 'assist')
  const exceeded = new StructuredInterviewResponseDecoder(3)
  assert.equal(exceeded.push('{"disposition":"assist","answer":"abc'), 'abc')
  assert.throws(() => exceeded.push('d'), InterviewResponseProtocolError)
  assert.throws(() => exceeded.push('"}'), InterviewResponseProtocolError)
  assert.throws(() => exceeded.finish(), InterviewResponseProtocolError)
  const wait = new StructuredInterviewResponseDecoder(3)
  assert.throws(() => wait.push(reply('    ', 'wait')), InterviewResponseProtocolError)
  const emoji = new StructuredInterviewResponseDecoder(1)
  assert.throws(() => emoji.push(reply('🧠')), InterviewResponseProtocolError)
  const done = new StructuredInterviewResponseDecoder()
  done.push(reply('', 'wait')); done.finish()
  assert.throws(() => done.push(''), InterviewResponseProtocolError)
  for (const limit of [0, -1, Infinity, 1.5, NaN]) assert.throws(() => new StructuredInterviewResponseDecoder(limit), /positive whole/)
  const nonString = new StructuredInterviewResponseDecoder()
  assert.throws(() => nonString.push(null as unknown as string), InterviewResponseProtocolError)
})
