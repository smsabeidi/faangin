import mammoth from 'mammoth/mammoth.browser'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl
interface DocumentBridge {
  onParse(listener: (command: { id: string; format: string; bytes: ArrayBuffer }) => void): () => void
  result(id: string, text: string, error?: string): void
}
const bridge = (window as unknown as { faanginDocument: DocumentBridge }).faanginDocument
bridge.onParse(async ({ id, format, bytes }) => {
  try {
    let text = ''
    if (format === 'docx') {
      const result = await mammoth.extractRawText({ arrayBuffer: bytes })
      text = result.value
    } else if (format === 'pdf') {
      const document = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: true }).promise
      try {
        if (document.numPages > 100) throw new Error('Profile PDFs must contain at most 100 pages.')
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
          const page = await document.getPage(pageNumber), content = await page.getTextContent()
          text += content.items.map(item => 'str' in item ? item.str : '').join(' ') + '\n'
          page.cleanup()
          if (text.length > 100_000) throw new Error('Profile text exceeds 100,000 characters.')
        }
      } finally { await document.destroy() }
    } else throw new Error('Unsupported document format.')
    if (!text.trim()) throw new Error('No selectable text was found. Paste text for scanned documents.')
    if (text.length > 100_000) throw new Error('Profile text exceeds 100,000 characters.')
    bridge.result(id, text)
  } catch (error) { bridge.result(id, '', error instanceof Error ? error.message : 'The document could not be read.') }
})
