import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
// @ts-expect-error Node executes this build helper directly; it has no declaration file.
import { encodeIco } from '../scripts/lib/ico.mjs'

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// Only the PNG signature and IHDR dimensions are inspected, so a header-shaped payload is enough.
function png(width: number, height = width, fill = 0x42) {
  const buffer = Buffer.alloc(33, fill)
  signature.copy(buffer)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12)
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function readDirectory(ico: Buffer) {
  assert.equal(ico.readUInt16LE(0), 0)
  assert.equal(ico.readUInt16LE(2), 1)
  return Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
    const entry = 6 + index * 16
    const bytes = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12)
    return { width: ico.readUInt8(entry) || 256, height: ico.readUInt8(entry + 1) || 256, planes: ico.readUInt16LE(entry + 4), bitCount: ico.readUInt16LE(entry + 6), payload: ico.subarray(offset, offset + bytes) }
  })
}

test('ICO directory describes every PNG payload and encodes 256 px as the zero width byte', () => {
  const entries = [{ size: 16, png: png(16) }, { size: 256, png: png(256, 256, 0x7f) }]
  const ico = encodeIco(entries)
  assert.equal(ico.readUInt8(6 + 16), 0)
  const directory = readDirectory(ico)
  assert.deepEqual(directory.map(entry => [entry.width, entry.height, entry.planes, entry.bitCount]), [[16, 16, 1, 32], [256, 256, 1, 32]])
  assert.ok(directory[0].payload.equals(entries[0].png))
  assert.ok(directory[1].payload.equals(entries[1].png))
  assert.equal(ico.length, 6 + 16 * 2 + entries[0].png.length + entries[1].png.length)
})

test('ICO encoder rejects empty, duplicate, out-of-range, non-PNG and mis-sized entries', () => {
  assert.throws(() => encodeIco([]), /at least one/)
  assert.throws(() => encodeIco([{ size: 16, png: png(16) }, { size: 16, png: png(16) }]), /distinct/)
  for (const size of [0, 257, 1.5, -1]) assert.throws(() => encodeIco([{ size, png: png(16) }]), /1 to 256/)
  assert.throws(() => encodeIco([{ size: 16, png: Buffer.from('not a png, not even close') }]), /not a PNG/)
  assert.throws(() => encodeIco([{ size: 16, png: png(32) }]), /16x16/)
})

test('committed resources/icon.ico carries the Windows shell sizes as PNG entries', async () => {
  const directory = readDirectory(await readFile('resources/icon.ico'))
  assert.deepEqual(directory.map(entry => entry.width), [16, 24, 32, 48, 64, 128, 256])
  for (const entry of directory) {
    assert.ok(entry.payload.subarray(0, 8).equals(signature))
    assert.equal(entry.payload.readUInt32BE(16), entry.width)
    assert.equal(entry.payload.readUInt32BE(20), entry.height)
  }
})
