import type { Answer, TranscriptReference } from './types'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { toMarkdown } from 'mdast-util-to-markdown'

export function sourceLabel(href: string | undefined): string | null {
  return /^#source-(T[1-9]\d{0,2})$/.exec(href ?? '')?.[1] ?? null
}

/** Source snapshots are application metadata, never URLs supplied by a model. */
export function validateTranscriptReferences(value: unknown, admittedIds: readonly string[]): TranscriptReference[] {
  if (!Array.isArray(value) || value.length > 200 || !Array.isArray(admittedIds)) throw new Error('Invalid transcript references.')
  const ids = new Set(admittedIds), seen = new Set<string>()
  let characters = 0
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid transcript reference.')
    const item = entry as Record<string, unknown>
    if (Object.keys(item).some(key => !['label', 'turnId', 'channel', 'timestamp', 'text'].includes(key)) || item.label !== `T${index + 1}` || typeof item.turnId !== 'string' || !item.turnId || item.turnId.length > 128 || !ids.has(item.turnId) || seen.has(item.turnId) || typeof item.channel !== 'string' || !['manual', 'microphone', 'system'].includes(item.channel) || !Number.isSafeInteger(item.timestamp) || Number(item.timestamp) < 0 || !Number.isFinite(new Date(Number(item.timestamp)).getTime()) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 8_000) throw new Error('Invalid transcript reference.')
    characters += item.text.length
    if (characters > 24_000) throw new Error('Transcript references exceed the context budget.')
    seen.add(item.turnId)
    return { label: item.label as string, turnId: item.turnId, channel: item.channel as TranscriptReference['channel'], timestamp: item.timestamp as number, text: item.text }
  })
}

export function answerReferences(answer: Answer): TranscriptReference[] {
  if (!answer.transcriptReferences) return []
  try { return validateTranscriptReferences(answer.transcriptReferences, answer.context?.transcriptIds ?? []) } catch { return [] }
}

function fenced(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((size, run) => Math.max(size, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}

/** Keep copied/exported drafts readable after their in-app source buttons are gone. */
export function linkedTranscriptMarkdown(text: string, references: TranscriptReference[], prefix: string): string {
  if (!/^[a-z0-9-]+$/.test(prefix)) throw new Error('Invalid source anchor prefix.')
  if (!references.length && !text.includes('#source-')) return text
  const labels = new Set(references.map(item => item.label))
  const tree = fromMarkdown(text)
  // Use the same CommonMark grammar as the answer renderer. Rewrite actual
  // destinations, including reference definitions, without touching code.
  interface Node { type: string; url?: string; identifier?: string; children?: Node[]; value?: string }
  const unavailableDefinitions = new Set<string>()
  const root = tree as unknown as Node
  const collect = (node: Node) => {
    const label = node.type === 'definition' ? sourceLabel(node.url) : null
    if (label && !labels.has(label) && node.identifier) unavailableDefinitions.add(node.identifier)
    for (const child of node.children ?? []) collect(child)
  }
  collect(root)
  const rewrite = (node: Node): Node[] => {
    if (node.children) node.children = node.children.flatMap(rewrite)
    const label = (node.type === 'link' || node.type === 'definition') ? sourceLabel(node.url) : null
    if (label) {
      if (labels.has(label)) node.url = `#${prefix}-${label.toLowerCase()}`
      else return node.type === 'definition' ? [] : [...(node.children ?? []), { type: 'text', value: ' (source unavailable)' }]
    }
    if (node.type === 'linkReference' && node.identifier && unavailableDefinitions.has(node.identifier)) return [...(node.children ?? []), { type: 'text', value: ' (source unavailable)' }]
    return [node]
  }
  rewrite(root)
  const linked = toMarkdown(tree).trimEnd()
  return references.length ? `${linked}\n\n#### Transcript sources\n\n${references.map(item => `##### ${prefix}-${item.label.toLowerCase()}\n\n${item.label} · ${item.channel} · ${new Date(item.timestamp).toISOString()}\n\n${fenced(item.text)}`).join('\n\n')}` : linked
}
