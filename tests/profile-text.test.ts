import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeProfileText } from '../src/main/profile-text'
import { text } from '../src/main/validation'
import { darwinPlatform, linuxPlatform, win32Platform } from '../src/main/platform'

const utf16le = (value: string, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(value, 'utf16le')])
const utf16be = (value: string) => { const body = Buffer.from(value, 'utf16le'); body.swap16(); return Buffer.concat([Buffer.from([0xfe, 0xff]), body]) }
const WORDS = 'Résumé — “Staff Engineer” • café'

test('UTF-8 profile documents decode unchanged, with or without a byte order mark', () => {
  assert.equal(decodeProfileText(Buffer.from(WORDS, 'utf8')), WORDS)
  assert.equal(decodeProfileText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(WORDS, 'utf8')])), WORDS)
  assert.equal(decodeProfileText(Buffer.from('plain ascii\nsecond line')), 'plain ascii\nsecond line')
  assert.equal(decodeProfileText(Buffer.from(WORDS, 'utf8'), 'windows-1252'), WORDS, 'valid UTF-8 never reaches the legacy decoder')
})

test('UTF-16 documents from Notepad "Unicode" and PowerShell redirection decode through their byte order mark', () => {
  assert.equal(decodeProfileText(utf16le(WORDS)), WORDS)
  assert.equal(decodeProfileText(utf16be(WORDS)), WORDS)
  assert.equal(decodeProfileText(utf16le(WORDS), 'windows-1252'), WORDS)
})

test('Windows ANSI documents decode through the legacy code page only after UTF-8 fails', () => {
  // 0x93 0x94 are curly quotes, 0x96 an en dash, 0x95 a bullet and 0xE9 an e acute in Windows-1252.
  const ansi = Buffer.from([0x93, 0x52, 0xe9, 0x73, 0x75, 0x6d, 0xe9, 0x94, 0x20, 0x96, 0x20, 0x95])
  assert.equal(decodeProfileText(ansi, 'windows-1252'), '“Résumé” – •')
  assert.equal(decodeProfileText(ansi, win32Platform.legacyTextEncoding), '“Résumé” – •')
})

test('without a legacy code page an undecodable file is refused with an actionable message', () => {
  const ansi = Buffer.from([0x93, 0x52, 0xe9, 0x94])
  assert.throws(() => decodeProfileText(ansi), /could not be read.*UTF-8/)
  assert.throws(() => decodeProfileText(ansi, null), /could not be read.*UTF-8/)
  assert.doesNotThrow(() => decodeProfileText(Buffer.from('ok')))
})

test('a truncated UTF-16 file is refused rather than imported with a replacement character', () => {
  assert.throws(() => decodeProfileText(Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42]), 'windows-1252'), /could not be read.*UTF-8/)
  assert.throws(() => decodeProfileText(Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x00]), 'windows-1252'), /could not be read/)
})

test('binary content renamed to .txt still reaches the NUL check in validate.text', () => {
  const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00])
  assert.throws(() => text(decodeProfileText(binary, 'windows-1252'), 100_000), /Invalid text value/)
  assert.throws(() => text(decodeProfileText(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00])), 100_000), /Invalid text value/, 'UTF-32LE decodes with a NUL')
  assert.throws(() => text(decodeProfileText(Buffer.alloc(0)), 100_000), /Invalid text value/)
})

test('only Windows falls back to a legacy code page, so macOS and Linux keep refusing non-UTF-8 text', () => {
  assert.deepEqual([darwinPlatform.legacyTextEncoding, win32Platform.legacyTextEncoding, linuxPlatform.legacyTextEncoding], [null, 'windows-1252', null])
})
