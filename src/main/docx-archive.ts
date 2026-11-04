import { inflateRawSync } from 'node:zlib'

const MAX_EXPANDED_BYTES = 30 * 1024 * 1024
const END_OF_DIRECTORY = Buffer.from([0x50, 0x4b, 0x05, 0x06])
const malformed = () => new Error('The DOCX archive exceeds import limits or is malformed.')

/** Bound real decompression before the document reader opens an untrusted ZIP. */
export function validateDocxArchive(buffer: Buffer): void {
  // Use the same final directory record that the reader selects. DOCX imports are bounded ZIP32 archives.
  const end = buffer.lastIndexOf(END_OF_DIRECTORY)
  if (end < 0 || end + 22 > buffer.length || end + 22 + buffer.readUInt16LE(end + 20) !== buffer.length) throw malformed()
  const entries = buffer.readUInt16LE(end + 10)
  const directorySize = buffer.readUInt32LE(end + 12)
  const directoryStart = buffer.readUInt32LE(end + 16)
  if (buffer.readUInt32LE(end + 4) !== 0 || buffer.readUInt16LE(end + 8) !== entries || !entries || entries > 1000 || directoryStart + directorySize !== end) throw malformed()

  let offset = directoryStart, expanded = 0, compressed = 0
  for (let entry = 0; entry < entries; entry++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) throw malformed()
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const expandedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const local = buffer.readUInt32LE(offset + 42)
    const entryDisk = buffer.readUInt16LE(offset + 34)
    offset += 46 + nameLength + extraLength + commentLength
    expanded += expandedSize
    compressed += compressedSize
    if ((flags & 1) !== 0 || entryDisk !== 0 || offset > end || expanded > MAX_EXPANDED_BYTES || compressed > directoryStart) throw malformed()
    if (local + 30 > directoryStart || buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 8) !== method) throw malformed()
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    if (start + compressedSize > directoryStart) throw malformed()

    if (method === 0 && compressedSize === expandedSize) continue
    if (method !== 8) throw malformed()
    try {
      const content = inflateRawSync(buffer.subarray(start, start + compressedSize), { maxOutputLength: Math.max(1, expandedSize) })
      if (content.length === expandedSize) continue
    } catch { /* A malformed stream or one that expands past its declared limit. */ }
    throw malformed()
  }
  if (offset !== end) throw malformed()
}
