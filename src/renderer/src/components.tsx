import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import { Check, ChevronDown, Copy, LoaderCircle, X } from 'lucide-react'
import { sourceLabel } from '../../shared/transcript-references'

export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand${compact ? ' brand-compact' : ''}`}><span className="brand-wordmark">faangin<span className="brand-period">.</span></span></div>
}

export function IconButton({ children, label, onClick, disabled = false, className = '' }: { children: ReactNode; label: string; onClick: () => void; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>
}

export function Spinner({ label = 'Working' }: { label?: string }) { return <span className="inline-status"><LoaderCircle className="spin" size={15}/>{label}</span> }

export function Toggle({ checked, onChange, label, description, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return <label className="toggle-row"><span><span className="field-label">{label}</span>{description && <span className="field-description">{description}</span>}</span><input type="checkbox" className="toggle-input" checked={checked} onChange={e => onChange(e.target.checked)} disabled={disabled}/><span className="toggle-track" aria-hidden="true"/></label>
}

export function Field({ label, description, children, className = '' }: { label: string; description?: string; children: ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span className="field-label">{label}</span>{description && <span className="field-description">{description}</span>}{children}</label>
}

export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <span className="select-wrap"><select {...props}>{children}</select><ChevronDown size={14} aria-hidden="true"/></span>
}

export function Modal({ title, description, children, onClose }: { title: string; description?: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLElement>('button, input, textarea, select, a[href]')?.focus()
    return () => previous?.focus()
  }, [])
  return <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onKeyDown={e => {
    if (e.key === 'Escape') onClose()
    if (e.key === 'Tab') {
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') || [])]
      if (!controls.length) { e.preventDefault(); return }
      const first = controls[0], last = controls[controls.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }}><div className="modal-heading"><h2 id="modal-title">{title}</h2><IconButton label="Close dialog" onClick={onClose}><X size={18}/></IconButton></div>{description && <p className="muted">{description}</p>}{children}</section></div>
}

export const MarkdownText = memo(function MarkdownText({ text, sourceLabels = [], onSource }: { text: string; sourceLabels?: string[]; onSource?: (label: string) => void }) {
  return <div className="markdown"><Markdown components={{ pre: ({ children }) => <CodeBlock>{children}</CodeBlock>, a: ({ children, href }) => {
    const label = sourceLabel(href)
    if (label) return sourceLabels.includes(label) && onSource ? <button type="button" className="source-link" onClick={() => onSource(label)} title={`Read transcript source ${label}`}>{children}</button> : <span title="This source is unavailable.">{children} (source unavailable)</span>
    return <a href={href} target="_blank" rel="noreferrer">{children}</a>
  } }}>{text}</Markdown></div>
})

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const child = children as React.ReactElement<{ children?: string; className?: string }>
    const value = typeof child?.props?.children === 'string' ? child.props.children : ''
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1800) } catch { setCopied(false) }
  }
  const child = children as React.ReactElement<{ className?: string }>
  const language = child?.props?.className?.replace('language-', '') || 'code'
  return <div className="code-block"><div className="code-heading"><span>{language}</span><button type="button" onClick={copy} aria-label="Copy code">{copied ? <Check size={13}/> : <Copy size={13}/>} {copied ? 'Copied' : 'Copy'}</button></div><pre>{children}</pre></div>
}

export function shortTime(value: number) { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
export function shortDate(value: number) { return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' }) }
