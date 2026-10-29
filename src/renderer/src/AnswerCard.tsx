import { CircleHelp, Copy, RotateCcw, Sparkles, Square } from 'lucide-react'
import type { Answer } from '../../shared/types'
import { answerReferences, linkedTranscriptMarkdown } from '../../shared/transcript-references'
import { IconButton, shortTime } from './components'
import AnswerText from './AnswerText'
import { actionLabels, actions } from './workspace-actions'
import { canRetryAnswer, interruptedAnswerLabel } from './answer-status'

function formatDuration(ms: number): string { return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s` }

export default function AnswerCard({ answer, copy, cancel, retry, compact = false, current = false, questionUpdated = false }: { answer: Answer; copy: (text: string, message?: string) => Promise<void>; cancel: () => Promise<unknown>; retry: (answer: Answer) => Promise<unknown>; compact?: boolean; current?: boolean; questionUpdated?: boolean }) {
  const Icon = actions.find(item => item.action === answer.action)?.icon || Sparkles
  const interruption = interruptedAnswerLabel(answer)
  const updated = questionUpdated && !interruption
  return <article className={`answer-card ${compact ? 'compact' : ''} ${interruption ? 'interrupted' : updated ? 'outdated-answer' : ''} ${current && !interruption && !updated ? 'current-answer' : ''}`} data-answer-id={answer.id} data-answer-state={interruption ? 'interrupted' : updated ? 'outdated' : answer.status} data-current-answer={current && !updated && !interruption || undefined}>
    {interruption && <div className="answer-interruption" role="status"><strong>{interruption}</strong><span>{answer.text ? 'Partial response kept for reference. It may no longer fit the current question.' : 'This response stopped before it was ready. Choose Answer latest for the current question.'}</span></div>}
    {updated && <div className="answer-interruption" role="status"><strong>Question updated</strong><span>This response used an earlier question. Choose Answer latest to use the updated question.</span></div>}
    <div className="answer-card-heading"><span className="answer-avatar"><Icon size={16}/></span><div><strong>{answer.origin === 'automatic' ? 'Automatic suggestion' : actionLabels[answer.action]}{current && !interruption && !updated && <small className="answer-current-label">Current answer</small>}</strong><span>{compact ? <time dateTime={new Date(answer.createdAt).toISOString()}>{shortTime(answer.createdAt)}</time> : <>{answer.model} <span>·</span> {shortTime(answer.createdAt)}</>}</span></div><div className="answer-options">{answer.status === 'streaming' ? <button type="button" className="text-button stop" onClick={() => { void cancel() }}><Square size={13}/>Cancel</button> : <><IconButton label={interruption ? 'Copy interrupted response' : 'Copy answer'} disabled={!answer.text} onClick={() => { void copy(linkedTranscriptMarkdown(answer.text, answerReferences(answer), 'transcript-source')) }}><Copy size={16}/></IconButton>{canRetryAnswer(answer, questionUpdated) && <IconButton label="Retry this request" onClick={() => { void retry(answer) }}><RotateCcw size={16}/></IconButton>}</>}</div></div>
    {answer.prompt && <p className="answer-prompt">{answer.prompt}</p>}
    {answer.text ? <AnswerText key={answer.requestId} answer={answer}/> : answer.status === 'streaming' ? <div className="thinking-dots" role="status" aria-label="Preparing your response"><span/><span/><span/><small>Connecting the dots…</small></div> : null}
    {answer.status === 'streaming' && answer.text && <span className="stream-cursor" aria-label="Response streaming"/>}
    {answer.error && <div className="answer-error"><CircleHelp size={14}/>{answer.error}</div>}
    {answer.status === 'cancelled' && !interruption && <p className="answer-footnote">Cancelled · this partial answer is incomplete.</p>}
    {answer.status === 'failed' && !answer.error && !updated && !interruption && <p className="answer-footnote">This request couldn’t finish. You can retry when ready.</p>}
    {!compact && <AnswerContext answer={answer}/>}
    {answer.usedPartialContext && <p className="answer-footnote">Used live speech that was still being finalized. Check any uncertain details.</p>}
    {compact ? <details className="answer-footnote answer-performance"><summary>Response details</summary><p className="answer-model">Model · {answer.model}</p><AnswerContext answer={answer}/><AnswerPerformance answer={answer}/></details> : <AnswerPerformance answer={answer}/>}
  </article>
}

function AnswerContext({ answer }: { answer: Answer }) {
  return answer.context ? <details className="answer-footnote"><summary>Included context · {answer.context.transcriptIds.length} transcript turns · {answer.context.attachmentIds.length} images · {answer.context.memorySourceIds.length} prior excerpts</summary><p>{answer.context.priorAnswerIds.length} prior answers from this session. {answer.context.truncated ? 'Older or oversized context was trimmed to the request budget.' : 'Selected context fit within the request budget.'}</p></details> : null
}

function AnswerPerformance({ answer }: { answer: Answer }) {
  return <>{answer.firstTokenMs !== undefined && <p className="answer-footnote">First text {formatDuration(answer.firstTokenMs)}{answer.totalMs !== undefined ? ` · Finished in ${formatDuration(answer.totalMs)}` : ''}</p>}{answer.status === 'complete' && (answer.inputTokens !== undefined || answer.outputTokens !== undefined) ? <p className="answer-footnote">{answer.inputTokens ?? '—'} input / {answer.outputTokens ?? '—'} output tokens</p> : null}</>
}
