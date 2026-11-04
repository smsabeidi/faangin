import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Repository } from '../src/main/repository'
import { endSessionAtShutdown, type InterruptedSessionStore } from '../src/main/session-end'
import type { SessionStatus } from '../src/shared/types'

function recorder(fail: Array<'incomplete' | 'status'> = []) {
  const calls: string[] = []
  const store: InterruptedSessionStore = {
    markTranscriptIncomplete: id => { calls.push(`incomplete:${id}`); if (fail.includes('incomplete')) throw new Error('locked') },
    setStatus: (id, status: SessionStatus) => { calls.push(`status:${id}:${status}`); if (fail.includes('status')) throw new Error('locked') }
  }
  return { calls, store }
}

test('a live capture is ended with the transcript flagged only when speech was still unfinalized', () => {
  const finished = recorder(); endSessionAtShutdown(finished.store, 's1', false)
  assert.deepEqual(finished.calls, ['status:s1:ended'])
  const midSentence = recorder(); endSessionAtShutdown(midSentence.store, 's1', true)
  assert.deepEqual(midSentence.calls, ['incomplete:s1', 'status:s1:ended'])
})

test('with no capture running nothing is written, and a failing write never stops the shutdown or the other write', () => {
  const idle = recorder(); endSessionAtShutdown(idle.store, null, true); assert.deepEqual(idle.calls, [])
  const flagFails = recorder(['incomplete']); assert.doesNotThrow(() => endSessionAtShutdown(flagFails.store, 's1', true))
  assert.deepEqual(flagFails.calls, ['incomplete:s1', 'status:s1:ended'])
  const everythingFails = recorder(['incomplete', 'status']); assert.doesNotThrow(() => endSessionAtShutdown(everythingFails.store, 's1', true))
})

test('a session ended at shutdown keeps its real end time and incomplete flag across the next launch, which would otherwise stamp its own time', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'faangin-session-end-')), path = join(directory, 'test.sqlite')
  let repo = new Repository(path)
  try {
    const interrupted = repo.create('interview'), abandoned = repo.create('meeting')
    repo.setStatus(interrupted.id, 'recording'); repo.setStatus(abandoned.id, 'recording')
    endSessionAtShutdown(repo, interrupted.id, true)
    const endedAt = repo.get(interrupted.id).endedAt
    assert.ok(endedAt); assert.equal(repo.get(interrupted.id).status, 'ended'); assert.equal(repo.get(interrupted.id).transcriptIncomplete, true)
    repo.close()
    await new Promise(resolve => setTimeout(resolve, 15))
    repo = new Repository(path)
    assert.equal(repo.get(interrupted.id).endedAt, endedAt); assert.equal(repo.get(interrupted.id).transcriptIncomplete, true)
    // Without the shutdown write, the launch ends the row later and never learns that speech was dropped.
    assert.ok(repo.get(abandoned.id).endedAt! > endedAt); assert.equal(repo.get(abandoned.id).transcriptIncomplete, false)
  } finally { repo.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})
