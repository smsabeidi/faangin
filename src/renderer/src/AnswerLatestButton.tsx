import { MessageSquare } from 'lucide-react'
import type { WorkspaceMode } from '../../shared/types'
import { answerLatestBlocked } from './answer-status'

export default function AnswerLatestButton({ mode, hasQuestion, working, busy, updatingQuestion, onClick, className = 'button subtle small' }: { mode: WorkspaceMode; hasQuestion: boolean; working: boolean; busy: boolean; updatingQuestion: boolean; onClick: () => void; className?: string }) {
  const label = mode === 'interview' ? updatingQuestion ? 'Answer latest' : 'Answer follow-up' : 'Reply'
  const title = !hasQuestion ? 'Listen to a question or type a follow-up first' : updatingQuestion && mode === 'interview' ? 'Stop this interview’s current response and answer the latest question' : 'Answer the latest question using this session’s context'
  return <button className={className} title={title} data-interview-takeover={mode === 'interview' || undefined} disabled={answerLatestBlocked(mode, hasQuestion, working, busy)} onClick={onClick}><MessageSquare size={14}/>{label}</button>
}
