import { useEffect, useId, useRef, useState } from 'react'
import { Copy, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react'
import { PRESET_LIMITS, type PresetDraft, type PresetKind, type PromptPreset, type SessionPresetChoice } from '../../main/presets'
import { MEMORY_LIMITS, type MemoryCandidate, type MemorySnippet } from '../../main/context-memory'
import type { WorkspaceMode } from '../../shared/types'

export interface PresetManagerProps {
  presets: readonly PromptPreset[]
  busy?: boolean
  onCreate(draft: PresetDraft): Promise<unknown>
  onUpdate(id: string, draft: PresetDraft, expectedRevision: number): Promise<unknown>
  onDuplicate(id: string): Promise<unknown>
  onDelete(id: string): Promise<unknown>
  onRestoreDefaults(): Promise<unknown>
}
const emptyDraft = (): PresetDraft => ({ name: '', kind: 'response', mode: 'any', instructions: '' })
const fieldStyle = { display: 'grid', gap: 6 } as const
const sectionStyle = { display: 'grid', gap: 16, padding: 20 } as const
function message(error: unknown): string { return error instanceof Error ? error.message : 'The change could not be saved. Try again.' }

export function PresetManager({ presets, busy = false, onCreate, onUpdate, onDuplicate, onDelete, onRestoreDefaults }: PresetManagerProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<PresetDraft>(emptyDraft)
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [restore, setRestore] = useState(false)
  const revision = useRef(0), expectedRevision = useRef(0), formId = useId()
  const locked = busy || pending
  const edited = presets.find(preset => preset.id === editingId)
  const patch = <K extends keyof PresetDraft>(key: K, value: PresetDraft[K]) => { revision.current++; setDraft(previous => ({ ...previous, [key]: value })); setDirty(true); setNotice('') }
  const choose = (preset: PromptPreset | null) => {
    revision.current++; expectedRevision.current = preset?.revision ?? 0
    setEditingId(preset?.id ?? null); setDraft(preset ? { name: preset.name, kind: preset.kind, mode: preset.mode, instructions: preset.instructions } : emptyDraft())
    setDirty(false); setDeleteId(null); setError(''); setNotice('')
  }
  useEffect(() => {
    if (editingId && !edited) { setError('This preset was removed in another window. Your draft is still here; create a new preset to keep it.') }
    if (edited && !dirty) { expectedRevision.current = edited.revision; setDraft({ name: edited.name, kind: edited.kind, mode: edited.mode, instructions: edited.instructions }) }
  }, [edited, editingId, dirty])
  const perform = async (operation: () => Promise<unknown>, success: string) => {
    if (locked) return
    setPending(true); setError(''); setNotice('')
    try { await operation(); setNotice(success) } catch (failure) { setError(message(failure)) } finally { setPending(false) }
  }
  const save = async () => {
    const submitted = revision.current, submittedId = editingId, snapshot = { ...draft }
    await perform(async () => {
      const result = submittedId ? await onUpdate(submittedId, snapshot, expectedRevision.current) : await onCreate(snapshot)
      if (result && typeof result === 'object' && 'id' in result && 'revision' in result) {
        // A saved draft can keep changing while the request is in flight.
        // Retain its new identity/revision without marking those later edits clean.
        setEditingId(String(result.id)); expectedRevision.current = Number(result.revision)
      } else if (submittedId) expectedRevision.current++
      if (revision.current === submitted) {
        setDirty(false)
        if (!submittedId && !(result && typeof result === 'object' && 'id' in result)) { setDraft(emptyDraft()); setEditingId(null) }
      }
    }, submittedId ? 'Preset saved.' : 'Preset created.')
  }
  return <section className="settings-card" style={sectionStyle} aria-labelledby={`${formId}-heading`}>
    <div><h2 id={`${formId}-heading`}>Response presets & note templates</h2><p className="muted">Save reusable instructions, then choose them for a session. Selecting a preset does not start capture or generate a response.</p></div>
    <div className="button-row"><button className="button subtle small" disabled={locked || (dirty && !!editingId)} title={dirty && editingId ? 'Save your draft or select Discard changes first.' : undefined} onClick={() => choose(null)}><Plus size={14}/>New preset</button><button className="button subtle small" disabled={locked} onClick={() => setRestore(true)}><RefreshCw size={14}/>Restore built-in defaults</button>{dirty && <button className="text-button" disabled={locked} onClick={() => choose(edited ?? null)}>Discard changes</button>}</div>
    {restore && <div className="connection-result" role="alert"><div><p>Restore the original built-in instructions and recreate deleted defaults? Your custom presets stay saved.</p><div className="button-row"><button className="button subtle small" disabled={locked} onClick={() => { void perform(async () => { await onRestoreDefaults(); setRestore(false) }, 'Built-in defaults restored.') }}>Restore defaults</button><button className="text-button" disabled={locked} onClick={() => setRestore(false)}>Keep current defaults</button></div></div></div>}
    <ul aria-label="Saved presets" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
      {presets.map(preset => <li key={preset.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className={`button ${editingId === preset.id ? 'primary' : 'subtle'} small`} aria-pressed={editingId === preset.id} disabled={locked || dirty} onClick={() => choose(preset)}>{preset.name}</button>
        <small className="muted">{preset.kind === 'notes' ? 'Note template' : 'Response'} · {preset.mode === 'any' ? 'Any session' : preset.mode === 'meeting' ? 'Meeting' : 'Interview'}{preset.builtIn ? ' · Built-in' : ''}</small>
        <button className="text-button" aria-label={`Duplicate ${preset.name}`} disabled={locked} onClick={() => { void perform(() => onDuplicate(preset.id), 'Preset duplicated. Select the copy to edit it.') }}><Copy size={14}/></button>
        <button className="text-button danger-text" aria-label={`Delete ${preset.name}`} disabled={locked} onClick={() => setDeleteId(preset.id)}><Trash2 size={14}/></button>
        {deleteId === preset.id && <div role="alert"><p>Delete this preset? Sessions using it will return to your global instructions or note template.</p><div className="button-row"><button className="button subtle small" disabled={locked} onClick={() => { void perform(async () => { await onDelete(preset.id); setDeleteId(null); if (editingId === preset.id && !dirty) choose(null) }, 'Preset deleted.') }}>Delete preset</button><button className="text-button" disabled={locked} onClick={() => setDeleteId(null)}>Keep preset</button></div></div>}
      </li>)}
    </ul>
    <form style={{ display: 'grid', gap: 14 }} onSubmit={event => { event.preventDefault(); if (!locked && dirty) void save() }}>
      <label style={fieldStyle}><span className="field-label">Preset name</span><input required maxLength={PRESET_LIMITS.name} value={draft.name} onChange={event => patch('name', event.target.value)} placeholder="A useful name"/></label>
      <div className="field-grid"><label style={fieldStyle}><span className="field-label">Kind</span><select value={draft.kind} disabled={!!editingId} onChange={event => patch('kind', event.target.value as PresetKind)}><option value="response">Response instructions</option><option value="notes">Note template</option></select></label><label style={fieldStyle}><span className="field-label">Session mode</span><select value={draft.mode} disabled={!!editingId} onChange={event => patch('mode', event.target.value as PresetDraft['mode'])}><option value="any">Any session</option><option value="meeting">Meeting</option><option value="interview">Interview</option></select></label></div>
      <label style={fieldStyle}><span className="field-label">{draft.kind === 'notes' ? 'Sections & instructions' : 'Response instructions'}</span><textarea required rows={6} maxLength={draft.kind === 'notes' ? PRESET_LIMITS.noteCharacters : PRESET_LIMITS.responseCharacters} value={draft.instructions} onChange={event => patch('instructions', event.target.value)} placeholder={draft.kind === 'notes' ? 'Summary; decisions; actions supported by the transcript; open questions.' : 'Tone, structure, and reasoning preferences…'}/><small className="muted">{draft.instructions.length.toLocaleString()} / {(draft.kind === 'notes' ? PRESET_LIMITS.noteCharacters : PRESET_LIMITS.responseCharacters).toLocaleString()} characters. Source boundaries and factuality still apply.</small></label>
      <div className="button-row"><button type="submit" className="button primary small" disabled={locked || !dirty || (!!editingId && !edited)}><Save size={14}/>{pending ? 'Saving…' : editingId ? 'Save preset' : 'Create preset'}</button>{editingId && !edited && <button type="button" className="button subtle small" disabled={locked} onClick={() => { revision.current++; setEditingId(null); setDirty(true); setError('') }}>Keep draft as a new preset</button>}{editingId && <small className="muted">Duplicate a preset to create an independent version.</small>}</div>
    </form>
    {error && <p className="danger-text" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>
}

export interface SessionPresetPickerProps {
  mode: WorkspaceMode
  presets: readonly PromptPreset[]
  choice: SessionPresetChoice
  busy?: boolean
  onSelect(kind: PresetKind, id: string | null): Promise<unknown>
}
export function SessionPresetPicker({ mode, presets, choice, busy = false, onSelect }: SessionPresetPickerProps) {
  const [pending, setPending] = useState(false), [error, setError] = useState('')
  const select = async (kind: PresetKind, id: string) => { setPending(true); setError(''); try { await onSelect(kind, id || null) } catch (failure) { setError(message(failure)) } finally { setPending(false) } }
  return <section className="settings-card" style={sectionStyle} aria-label="Session presets"><div><h2>Presets for this session</h2><p className="muted">A selected response preset replaces global response instructions for this session. A selected note template applies when you request notes.</p></div><div className="field-grid">{(['response', 'notes'] as PresetKind[]).map(kind => {
    const selectedId = kind === 'response' ? choice.responseId : choice.noteTemplateId
    const compatible = presets.filter(preset => preset.kind === kind && (preset.mode === 'any' || preset.mode === mode)), selected = compatible.find(preset => preset.id === selectedId)
    return <label key={kind} style={fieldStyle}><span className="field-label">{kind === 'response' ? 'Response preset' : 'Note template'}</span><select value={selectedId ?? ''} disabled={busy || pending} onChange={event => { void select(kind, event.target.value) }}><option value="">Use global {kind === 'response' ? 'instructions' : 'note template'}</option>{selectedId && !selected && <option value={selectedId}>Unavailable selection — choose another</option>}{compatible.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select>{selected && <details><summary>Preview selected instructions</summary><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.instructions}</p></details>}</label>
  })}</div><p className="settings-footnote">Request context includes your current saved brief, selected screenshots, bounded conversation, factual background, and explicitly selected prior-session excerpts. Prompt preferences do not add capture sources.</p>{error && <p className="danger-text" role="alert">{error}</p>}</section>
}

export interface PriorContextPickerProps {
  candidates: readonly MemoryCandidate[]
  selected: readonly MemorySnippet[]
  busy?: boolean
  onSearch(query: string): Promise<unknown>
  onSelect(ids: string[]): Promise<unknown>
  onEdit(id: string, text: string): Promise<unknown>
  onRemove(id: string): Promise<unknown>
}
export function PriorContextPicker({ candidates, selected, busy = false, onSearch, onSelect, onEdit, onRemove }: PriorContextPickerProps) {
  const [query, setQuery] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState(''), [searched, setSearched] = useState(false)
  const locked = busy || pending, selectedIds = selected.map(snippet => snippet.id), characters = selected.reduce((sum, snippet) => sum + snippet.text.length, 0)
  const perform = async (operation: () => Promise<unknown>): Promise<boolean> => { if (locked) return false; setPending(true); setError(''); try { await operation(); return true } catch (failure) { setError(message(failure)); return false } finally { setPending(false) } }
  return <section className="settings-card" style={sectionStyle} aria-label="Prior-session context"><div><h2>Selected prior-session context</h2><p className="muted">Search saved sessions locally and select only the excerpts you want in your next request. Nothing from another session is included automatically.</p></div>
    <form className="button-row" onSubmit={event => { event.preventDefault(); void perform(async () => { await onSearch(query); setSearched(true) }) }}><label style={{ ...fieldStyle, flex: 1 }}><span className="field-label">Search prior sessions</span><input type="search" maxLength={MEMORY_LIMITS.queryCharacters} value={query} onChange={event => setQuery(event.target.value)} placeholder="A topic or saved session title"/></label><button className="button subtle small" disabled={locked}><Search size={14}/>{pending ? 'Updating…' : 'Search saved sessions'}</button></form>
    <p role="status" className="muted">{selected.length} / {MEMORY_LIMITS.selected} excerpts selected · {characters.toLocaleString()} / {MEMORY_LIMITS.totalCharacters.toLocaleString()} characters.</p>
    {selected.map(snippet => <MemorySnippetEditor key={snippet.id} snippet={snippet} disabled={locked} onEdit={text => perform(() => onEdit(snippet.id, text))} onRemove={() => { void perform(() => onRemove(snippet.id)) }}/>) }
    {searched && !candidates.length && <p role="status">No matching saved excerpts. Try another topic or session title.</p>}
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }} aria-label="Available prior-session excerpts">{candidates.map(candidate => {
      const checked = selectedIds.includes(candidate.id)
      return <li key={candidate.id}><label style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}><input type="checkbox" checked={checked} disabled={locked || (!checked && selected.length >= MEMORY_LIMITS.selected)} onChange={event => { const next = event.target.checked ? [...selectedIds, candidate.id] : selectedIds.filter(id => id !== candidate.id); void perform(() => onSelect(next)) }}/><span><strong>{candidate.sessionTitle}</strong><small className="muted" style={{ display: 'block' }}>{candidate.label} · {new Date(candidate.sourceTimestamp).toLocaleString()}{candidate.truncated ? ' · excerpt' : ''}</small><span style={{ display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 6 }}>{candidate.text}</span></span></label></li>
    })}</ul><p className="settings-footnote">Discovery shows saved notes, up to 200 recent committed transcript turns and 99 completed answers per saved session. Excerpts are limited to 2,000 characters each. Deleted, reset, or changed sources must be reselected before use. Generated answers remain attributed as generated text.</p>{error && <p className="danger-text" role="alert">{error}</p>}
  </section>
}

function MemorySnippetEditor({ snippet, disabled, onEdit, onRemove }: { snippet: MemorySnippet; disabled: boolean; onEdit(text: string): Promise<boolean>; onRemove(): void }) {
  const [text, setText] = useState(snippet.text), [dirty, setDirty] = useState(false), revision = useRef(0), labelId = useId()
  useEffect(() => { if (!dirty) setText(snippet.text) }, [snippet.text, dirty])
  const save = async () => { const submitted = revision.current, saved = await onEdit(text); if (saved && revision.current === submitted) setDirty(false) }
  return <article style={{ display: 'grid', gap: 8 }} aria-labelledby={labelId}><div className="button-row"><strong id={labelId}>{snippet.sessionTitle}</strong><small className="muted">{snippet.label}{snippet.edited ? ' · edited excerpt' : ''}</small><button className="text-button danger-text" disabled={disabled} onClick={onRemove} aria-label={`Remove selected excerpt from ${snippet.sessionTitle}`}><Trash2 size={14}/>Remove</button></div><label style={fieldStyle}><span className="field-label">Excerpt included in requests</span><textarea rows={4} maxLength={MEMORY_LIMITS.snippetCharacters} value={text} onChange={event => { revision.current++; setText(event.target.value); setDirty(true) }}/></label><div className="button-row"><button className="button subtle small" disabled={disabled || !dirty || !text.trim()} onClick={() => { void save() }}><Save size={14}/>Save excerpt edits</button>{dirty && <><small className="muted">Unsaved changes are not included in requests.</small><button className="text-button" disabled={disabled} onClick={() => { revision.current++; setText(snippet.text); setDirty(false) }}>Discard edits</button></>}</div></article>
}
