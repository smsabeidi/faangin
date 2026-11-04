const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const HEADER_BYTES = 6
const ENTRY_BYTES = 16

/**
 * Encodes square PNG renders as one Windows ICO without an image library. Windows Vista and later
 * read PNG-compressed entries directly, so no BMP/DIB conversion is needed and the file stays small.
 * Each PNG must already be rendered at its `size`; 256 is the largest size the format can describe
 * because the one-byte width/height fields wrap to 0 for it.
 */
export function encodeIco(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('ICO needs at least one PNG entry.')
  if (new Set(entries.map(entry => entry.size)).size !== entries.length) throw new Error('ICO entries must have distinct sizes.')
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt16LE(1, 2) // ICONDIR: reserved 0, type 1 (icon), count
  header.writeUInt16LE(entries.length, 4)
  const directory = Buffer.alloc(ENTRY_BYTES * entries.length)
  let offset = HEADER_BYTES + directory.length
  entries.forEach(({ size, png }, index) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) throw new Error(`ICO entry size must be an integer from 1 to 256, received ${size}.`)
    if (!Buffer.isBuffer(png) || png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`ICO entry ${size} is not a PNG.`)
    if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) throw new Error(`ICO entry ${size} must be a ${size}x${size} PNG.`)
    // ICONDIRENTRY: width, height, colour count (0 for 32-bit), reserved, planes, bit count, bytes, offset.
    const entry = index * ENTRY_BYTES
    directory.writeUInt8(size & 0xff, entry)
    directory.writeUInt8(size & 0xff, entry + 1)
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(png.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, directory, ...entries.map(entry => entry.png)])
}
