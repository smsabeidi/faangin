import { useEffect, useRef, useState } from 'react'
import { Check, Code2 } from 'lucide-react'
import { DEFAULT_INTERVIEW_CONTEXT, type InterviewContext, type Session } from '../../shared/types'
import { Field, Select } from './components'

export default function InterviewEditor({ session, busy, save }: { session: Session | null; busy: boolean; save: (brief: InterviewContext) => Promise<boolean> }) {
  const [draft, setDraft] = useState<InterviewContext>({ ...DEFAULT_INTERVIEW_CONTEXT, ...session?.interview })
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const revision = useRef(0)
  useEffect(() => { if (!dirty) setDraft({ ...DEFAULT_INTERVIEW_CONTEXT, ...session?.interview }) }, [session?.interview, dirty])
  const patch = <K extends keyof InterviewContext>(key: K, value: InterviewContext[K]) => { revision.current++; setDraft(previous => ({ ...previous, [key]: value })); setDirty(true); setSaved(false) }
  return <form className="interview-editor" onSubmit={event => {
    event.preventDefault()
    if (busy || !dirty) return
    const submitted = revision.current
    void save(draft).then(ok => { if (ok && revision.current === submitted) { setDirty(false); setSaved(true) } })
  }}>
    <div className="interview-intro"><Code2 size={24}/><div><h2>Keep the problem in view.</h2><p>Save the requirements and your attempt. Hint, Solve, Debug, Design, Behavioral, and Review use this brief alongside the current conversation.</p></div></div>
    <div className="field-grid">
      <Field label="Target company"><input value={draft.company} maxLength={120} placeholder="Google, Amazon, or any company" onChange={e => patch('company', e.target.value)}/></Field>
      <Field label="Target role"><input value={draft.role} maxLength={200} placeholder="Software engineer, senior, staff…" onChange={e => patch('role', e.target.value)}/></Field>
      <Field label="Interview round"><Select value={draft.round} onChange={e => patch('round', e.target.value as InterviewContext['round'])}><option value="coding">Coding</option><option value="system-design">System design</option><option value="behavioral">Behavioral</option></Select></Field>
      <Field label="Current stage"><Select value={draft.stage} onChange={e => patch('stage', e.target.value as InterviewContext['stage'])}><option value="clarify">Clarify requirements</option><option value="approach">Discuss an approach</option><option value="implement">Implement</option><option value="verify">Verify and test</option><option value="optimize">Optimize and discuss trade-offs</option></Select></Field>
    </div>
    <Field label="Problem or interview question"><textarea rows={4} value={draft.problem} maxLength={8000} placeholder="What is being asked? Include examples and required behavior." onChange={e => patch('problem', e.target.value)}/></Field>
    <Field label="Constraints and clarifications"><textarea rows={3} value={draft.constraints} maxLength={4000} placeholder="Input size, edge cases, assumptions confirmed with the interviewer…" onChange={e => patch('constraints', e.target.value)}/></Field>
    <Field label="Your code or explanation" description="Review evaluates the attempt you provide. Code is analyzed, not executed."><textarea className="candidate-attempt" rows={8} value={draft.candidateAttempt} maxLength={12000} spellCheck={false} placeholder="Paste your current code, design, or a real behavioral example." onChange={e => patch('candidateAttempt', e.target.value)}/></Field>
    <div className="interview-save"><span role="status">{dirty ? 'Save changes before requesting assistance.' : saved ? 'Interview brief saved on this device.' : 'This brief is saved with the session and sent with generated assistance.'}</span><button type="submit" className="button primary" disabled={!dirty || busy}><Check size={15}/>Save interview brief</button></div>
  </form>
}
