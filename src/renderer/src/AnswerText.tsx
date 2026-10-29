import { memo, useMemo, useState } from 'react'
import type { Answer } from '../../shared/types'
import { answerReferences } from '../../shared/transcript-references'
import { MarkdownText, Modal, shortTime } from './components'

export default memo(function AnswerText({ answer }: { answer: Answer }) {
  const references = useMemo(() => answerReferences(answer), [answer.transcriptReferences, answer.context?.transcriptIds])
  const labels = useMemo(() => references.map(item => item.label), [references])
  const [selected, setSelected] = useState<string | null>(null)
  const source = references.find(item => item.label === selected)
  return <><MarkdownText text={answer.text} sourceLabels={labels} onSource={setSelected}/>{references.length > 0 && <details className="answer-footnote transcript-sources"><summary>Transcript sources · {references.length}</summary><p>These are the finalized passages included when this draft was requested. Review each claim before copying.</p><div>{references.map(item => <button key={item.label} type="button" className="source-link" onClick={() => setSelected(item.label)}>{item.label} · {shortTime(item.timestamp)} · {item.channel === 'manual' ? 'Added context' : item.channel === 'system' ? 'System audio' : 'Microphone'}</button>)}</div></details>}{source && <Modal title={`Transcript source ${source.label}`} description={`${shortTime(source.timestamp)} · ${source.channel === 'manual' ? 'Added context' : source.channel === 'system' ? 'System audio' : 'Microphone'} · text included in the request`} onClose={() => setSelected(null)}><p className="transcript-source-text">{source.text}</p></Modal>}</>
})
