import { useState } from 'react'
import type { AppState, Session } from '../../shared/types'
import type { MemoryCandidate } from '../../main/context-memory'
import { PriorContextPicker, SessionPresetPicker } from './Presets'

export default function SessionContext({ state, session, busy }: { state: AppState; session: Session | null; busy: boolean }) {
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([])
  if (!session) return <div className="notes-empty-hint">Create a session to choose presets and prior-session context.</div>
  const catalog = state.presets
  const choice = catalog?.choices[session.id] ?? { responseId: null, noteTemplateId: null }
  return <div className="context-editor">
    {session.persistent === false && <p className="context-notice" role="status">This session is temporary. Its new context stays in memory and disappears when Faangin closes. You can export it before closing.</p>}
    <SessionPresetPicker mode={session.mode} presets={catalog?.presets ?? []} choice={choice} busy={busy || !!state.storageWarnings?.includes('preset-recovery-required')} onSelect={(kind, id) => window.faangin.choosePreset(session.id, kind, id)}/>
    <PriorContextPicker candidates={candidates} selected={session.memory ?? []} busy={busy}
      onSearch={async query => { setCandidates(await window.faangin.memoryCandidates(session.id, query)) }}
      onSelect={ids => window.faangin.selectMemory(session.id, ids, candidates)}
      onEdit={(id, text) => window.faangin.editMemory(session.id, id, text)}
      onRemove={id => window.faangin.selectMemory(session.id, (session.memory ?? []).filter(item => item.id !== id).map(item => item.id), candidates)}/>
    <p className="settings-footnote">Prior-session selection is kept for this open session. Reopening the app requires selecting excerpts again.</p>
  </div>
}
