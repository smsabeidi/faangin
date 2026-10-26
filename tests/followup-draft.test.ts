import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compilePrompt, ContextError } from '../src/main/prompts'
import { generateAnswer } from '../src/main/inference'
import { Repository } from '../src/main/repository'
import { sessionMarkdown } from '../src/main/session-export'
import { answerReferences, linkedTranscriptMarkdown, sourceLabel, validateTranscriptReferences } from '../src/shared/transcript-references'
import { DEFAULT_SETTINGS, type Answer, type Session, type TranscriptReference } from '../src/shared/types'

function session(): Session {
  return { id: 'meeting', title: 'Planning', mode: 'meeting', status: 'ended', createdAt: 1, updatedAt: 2, notes: 'UNSUPPORTED_NOTES_MARKER', transcript: [
    { id: 'late', sessionId: 'meeting', timestamp: 2_000, channel: 'system', text: 'We agreed to review the proposal. No owner or due date was assigned.' },
    { id: 'early', sessionId: 'meeting', timestamp: 1_000, channel: 'manual', text: 'We discussed the migration proposal.' },
    { id: 'partial', sessionId: 'meeting', timestamp: 3_000, channel: 'microphone', text: 'UNFINALIZED_PROMISE_MARKER', provisional: true },
    { id: 'foreign', sessionId: 'other', timestamp: 4_000, channel: 'manual', text: 'FOREIGN_SOURCE_MARKER' }
  ], answers: [], attachments: [], contextEpoch: 0 }
}
function reference(patch: Partial<TranscriptReference> = {}): TranscriptReference {
  return { label: 'T1', turnId: 'early', channel: 'manual', timestamp: 1_000, text: 'Supported source text.', ...patch }
}
function answer(patch: Partial<Answer> = {}): Answer {
  return { id: 'draft', requestId: 'request-draft', sessionId: 'meeting', action: 'draft', prompt: '', model: 'fixture-model', status: 'complete', createdAt: 5_000, text: 'Subject: Proposal\n\nWe discussed the migration. [T1](#source-T1)', transcriptReferences: [reference()], context: { transcriptIds: ['early'], attachmentIds: [], priorAnswerIds: [], memorySourceIds: [], truncated: false }, ...patch }
}

test('follow-up drafts receive finalized ordered evidence with exact source snapshots and omit selected images, memory, profile and prior answers', () => {
  const current = session(); current.answers.push(answer({ text: 'UNSUPPORTED_PRIOR_ANSWER_MARKER' }))
  const compiled = compilePrompt({ action: 'draft', prompt: 'Keep it concise.', settings: { ...DEFAULT_SETTINGS, includeHistory: true, profile: 'UNSUPPORTED_PROFILE_MARKER' }, session: current, attachments: [{ id: 'image', sessionId: 'meeting', name: 'PRIVATE_IMAGE_MARKER', dataUrl: 'invalid', createdAt: 1, width: 1, height: 1 }], memory: [{ id: 'memory', sessionId: 'old', source: 'selected_prior_session_excerpt', trust: 'untrusted_reference_data', text: 'UNSUPPORTED_MEMORY_MARKER' } as never] })
  assert.deepEqual(compiled.sources, { transcriptIds: ['early', 'late'], attachmentIds: [], priorAnswerIds: [], memorySourceIds: [], truncated: false, provisional: false })
  assert.deepEqual(compiled.transcriptReferences?.map(item => [item.label, item.turnId, item.text]), [['T1', 'early', current.transcript[1].text], ['T2', 'late', current.transcript[0].text]])
  const input = JSON.stringify(compiled.input)
  for (const marker of ['UNFINALIZED', 'FOREIGN_SOURCE', 'UNSUPPORTED_', 'PRIVATE_IMAGE']) assert(!input.includes(marker))
  assert(input.includes('#source-T1')); assert(input.includes('#source-T2'))
  assert(compiled.instructions.includes('Never invent recipients, owners, dates, promises, or agreements'))
  assert(compiled.instructions.includes('do not claim the message was sent'))
  assert.deepEqual(current.transcript.map(item => item.id), ['late', 'early', 'partial', 'foreign'])
})

test('drafts reject missing finalized conversation even if notes, images, profile or partial speech exist', () => {
  const current = session(); current.transcript = current.transcript.filter(item => item.provisional || item.sessionId !== current.id)
  assert.throws(() => compilePrompt({ action: 'draft', settings: DEFAULT_SETTINGS, session: current, attachments: [] }), ContextError)
})

test('OpenAI text-only draft requests ignore selected image capability and send only finalized transcript sources', async () => {
  let calls = 0
  const current = session(), model = 'text-only-fixture'
  const result = await generateAnswer({ action: 'draft', settings: { ...DEFAULT_SETTINGS, fastModel: model }, session: current, attachments: [{ id: 'selected-image', sessionId: current.id, name: 'problem.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', createdAt: 1, width: 1, height: 1 }] }, { apiKey: 'fixture-key-never-a-real-secret', signal: new AbortController().signal, onDelta() {}, transport: { fetch: (async (_url, init) => {
    calls++
    const body = JSON.parse(String(init?.body)), serialized = JSON.stringify(body.input)
    assert.equal(body.model, model); assert(!serialized.includes('input_image')); assert(serialized.includes('#source-T1'))
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model, output: [{ type: 'message', content: [{ type: 'output_text', text: 'LOCAL FIXTURE draft. [T1](#source-T1)' }] }] } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch } })
  assert.equal(calls, 1); assert.equal(result.model, model); assert.match(result.text, /#source-T1/)
})

test('draft source text is exactly the bounded request text and source labels survive reordered input', () => {
  const current = session(); current.mode = 'interview'
  current.transcript = Array.from({ length: 90 }, (_, i) => ({ id: `turn-${i}`, sessionId: 'meeting', channel: 'manual' as const, timestamp: i + 1, text: `Turn ${i}. `.padEnd(400, 'x') }))
  const compiled = compilePrompt({ action: 'draft', settings: DEFAULT_SETTINGS, session: current, attachments: [] })
  assert.equal(compiled.transcriptReferences?.length, 60)
  assert.equal(compiled.transcriptReferences?.reduce((n, source) => n + source.text.length, 0), 24_000)
  assert.equal(compiled.transcriptReferences?.[0].turnId, 'turn-30')
  assert.equal(compiled.transcriptReferences?.at(-1)?.label, 'T60')
  assert(compiled.sources.truncated)
  assert.doesNotThrow(() => validateTranscriptReferences(compiled.transcriptReferences, compiled.sources.transcriptIds))
})

test('source metadata rejects foreign IDs, duplicate identities, forged labels, extra destinations and invalid snapshots', () => {
  const valid = reference()
  assert.deepEqual(validateTranscriptReferences([valid], ['early']), [valid])
  for (const patch of [{ turnId: 'foreign' }, { label: 'T2' }, { channel: 'recipient' }, { timestamp: Number.MAX_SAFE_INTEGER }, { text: ' ' }, { text: 'x'.repeat(8_001) }, { href: 'https://example.test/collect' }]) {
    assert.throws(() => validateTranscriptReferences([{ ...valid, ...patch }], ['early']))
  }
  assert.throws(() => validateTranscriptReferences([valid, { ...valid, label: 'T2' }], ['early']))
  assert.throws(() => validateTranscriptReferences(Array.from({ length: 4 }, (_, i) => reference({ label: `T${i + 1}`, turnId: `turn-${i}`, text: 'x'.repeat(8_000) })), ['turn-0', 'turn-1', 'turn-2', 'turn-3']))
  assert.equal(sourceLabel('#source-T1'), 'T1')
  for (const href of ['#source-T0', '#source-T01', '#source-T1000', 'https://example.test/#source-T1', '#source-T1?key=x', 'javascript:alert(1)']) assert.equal(sourceLabel(href), null)
})

test('copy and export retain source excerpts with distinct anchors, safe fences and visibly unresolved model citations', () => {
  const first = answer({ text: 'Agreed to review. [T1](#source-T1) Claimed deadline. [T9](#source-T9)', transcriptReferences: [reference({ text: 'Source contains ```\n### UNTRUSTED_HEADER\n```' })] })
  const second = answer({ id: 'second', requestId: 'request-second', transcriptReferences: [reference({ text: 'A different request snapshot.' })] })
  const current = session(); current.answers = [first, second]
  const markdown = sessionMarkdown(current)
  assert(markdown.includes('[T1](#answer-1-source-t1)')); assert(markdown.includes('[T1](#answer-2-source-t1)'))
  assert(markdown.includes('T9 (source unavailable)')); assert(!markdown.includes('](#source-T9)'))
  assert(markdown.includes('````\nSource contains ```\n### UNTRUSTED_HEADER\n```\n````'))
  const copied = linkedTranscriptMarkdown(first.text, answerReferences(first), 'transcript-source')
  assert(copied.includes('#transcript-source-t1')); assert(copied.includes('1970-01-01T00:00:01.000Z'))
  assert.equal(linkedTranscriptMarkdown('No sources.', [], 'transcript-source'), 'No sources.')
  assert.throws(() => linkedTranscriptMarkdown('', [], 'bad prefix'))
})

test('copied source links preserve CommonMark titles and reference definitions while leaving code examples untouched', () => {
  const text = '[Decision](#source-T1 "Transcript source")\n\n[Review][evidence] and [Bad][unverified].\n\n[evidence]: <#source-T1> "Source title"\n[unverified]: #source-T9\n\n`[example](#source-T1)`\n\n```md\n[example](#source-T1)\n```'
  const copied = linkedTranscriptMarkdown(text, [reference()], 'transcript-source')
  assert(copied.includes('[Decision](#transcript-source-t1 "Transcript source")'))
  assert.match(copied, /\[evidence\]: #transcript-source-t1 "Source title"/)
  assert(copied.includes('Bad (source unavailable)'))
  assert(copied.includes('`[example](#source-T1)`'))
  assert(copied.includes('```md\n[example](#source-T1)\n```'))
  assert(!copied.includes('[unverified]:'))
  const nested = linkedTranscriptMarkdown('Quoted [claim][missing].\n\n> [missing]: #source-T9', [reference()], 'transcript-source')
  assert(nested.includes('claim (source unavailable)'))
  assert(!nested.includes('[missing]:'))
})

test('saved follow-up drafts retain their admitted source snapshots after database reopen and reset removes them', () => {
  const root = mkdtempSync(join(tmpdir(), 'faangin-draft-'))
  let repo = new Repository(join(root, 'workspace.sqlite'))
  try {
    const current = repo.create('meeting'), turn = repo.transcript(current.id, 'manual', 'The team agreed to review the proposal.', 'saved-draft-turn', 1_000)
    const compiled = compilePrompt({ action: 'draft', settings: DEFAULT_SETTINGS, session: repo.get(current.id), attachments: [] })
    const saved = answer({ sessionId: current.id, transcriptReferences: compiled.transcriptReferences, context: { transcriptIds: [turn.id], attachmentIds: [], priorAnswerIds: [], memorySourceIds: [], truncated: false } })
    repo.saveAnswer(saved); repo.close(); repo = new Repository(join(root, 'workspace.sqlite'))
    assert.deepEqual(repo.get(current.id).answers[0].transcriptReferences, compiled.transcriptReferences)
    assert(sessionMarkdown(repo.get(current.id) as Session).includes('The team agreed to review the proposal.'))
    repo.reset(current.id)
    assert.deepEqual(repo.get(current.id).answers, [])
  } finally { repo.close(); rmSync(root, { recursive: true, force: true }) }
})
