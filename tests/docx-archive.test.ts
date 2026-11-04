import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// @ts-expect-error Desktop smoke fixtures are plain JavaScript.
import { writeDocumentFixtures } from '../scripts/fixtures.mjs'
import { validateDocxArchive } from '../src/main/docx-archive'

test('DOCX validation checks real deflate output against directory sizes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'docx-archive-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeDocumentFixtures(dir)
  const document = await readFile(join(dir, 'profile.docx'))
  assert.doesNotThrow(() => validateDocxArchive(document))

  const forged = Buffer.from(document)
  const end = forged.length - 22
  const directoryStart = forged.readUInt32LE(end + 16)
  forged.writeUInt32LE(1, directoryStart + 24)
  assert.throws(() => validateDocxArchive(forged), /archive exceeds import limits or is malformed/)

  const extraEntries = Buffer.from(document)
  extraEntries.writeUInt16LE(1, end + 8)
  extraEntries.writeUInt16LE(1, end + 10)
  assert.throws(() => validateDocxArchive(extraEntries), /archive exceeds import limits or is malformed/)
})
