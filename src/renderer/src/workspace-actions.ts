import { Check, CircleHelp, Code2, FileText, Layers3, MessageSquare, Sparkles, Terminal } from 'lucide-react'
import type { Action, WorkspaceMode } from '../../shared/types'

export const actions: { action: Action; label: string; description: string; icon: typeof Sparkles; mode?: WorkspaceMode }[] = [
  { action: 'assist', label: 'Assist', description: 'Find the useful next step', icon: Sparkles },
  { action: 'reply', label: 'Reply', description: 'Prepare wording to say aloud from the conversation', icon: MessageSquare },
  { action: 'followup', label: 'Follow-up', description: 'Ask a sharper question', icon: CircleHelp, mode: 'meeting' },
  { action: 'draft', label: 'Draft', description: 'Prepare a follow-up message with transcript sources', icon: FileText, mode: 'meeting' },
  { action: 'recap', label: 'Recap', description: 'Catch up on the conversation', icon: Layers3, mode: 'meeting' },
  { action: 'hint', label: 'Hint', description: 'Get the next reasoning step', icon: CircleHelp, mode: 'interview' },
  { action: 'solve', label: 'Solve', description: 'Work through the problem', icon: Code2, mode: 'interview' },
  { action: 'review', label: 'Review', description: 'Review your code or explanation', icon: Check, mode: 'interview' },
  { action: 'debug', label: 'Debug', description: 'Find the issue and fix it', icon: Terminal, mode: 'interview' },
  { action: 'design', label: 'Design', description: 'Explore systems and tradeoffs', icon: Layers3, mode: 'interview' },
  { action: 'behavioral', label: 'Behavioral', description: 'Build a grounded answer', icon: MessageSquare, mode: 'interview' },
]
export const actionLabels: Record<Action, string> = { ask: 'Your question', assist: 'Assistance', reply: 'Suggested reply', followup: 'Follow-up questions', draft: 'Follow-up draft', recap: 'Session recap', hint: 'Next hint', solve: 'Coding solution', review: 'Attempt review', debug: 'Debugging', design: 'System design', behavioral: 'Behavioral answer', notes: 'Session notes' }
