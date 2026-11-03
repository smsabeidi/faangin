const UNREADABLE = 'This text file could not be read. Save it as UTF-8 or paste the text instead.'

/**
 * Decodes an imported .txt or .md profile document. UTF-8 (with or without a BOM) is the norm, and a UTF-16 BOM is
 * unambiguous: Notepad's "Unicode" option and Windows PowerShell 5.1 redirection both write it. `legacyEncoding` is the OS's
 * ANSI code page (Windows-1252 for Notepad "ANSI" and Word's plain text); it is only tried after UTF-8 fails, because a
 * single-byte decoder accepts every byte sequence, so it can never be asked first. Binary input still reaches
 * `validate.text`, which rejects NUL bytes.
 */
export function decodeProfileText(bytes: Uint8Array, legacyEncoding: string | null = null): string {
  const strict = (label: string) => new TextDecoder(label, { fatal: true }).decode(bytes)
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return strict('utf-16le')
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return strict('utf-16be')
    try { return strict('utf-8') }
    catch (error) { if (!legacyEncoding) throw error; return new TextDecoder(legacyEncoding).decode(bytes) }
  } catch { throw new Error(UNREADABLE) }
}
