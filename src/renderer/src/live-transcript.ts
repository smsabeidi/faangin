import type { AudioChannel } from '../../shared/types'

export type PartialTurn = { sessionId: string; channel: AudioChannel; itemId: string; text: string }
export type PartialCache = Record<string, PartialTurn>

export function revisePartial(previous: PartialCache, turn: PartialTurn): PartialCache {
  const next = { ...previous }, key = `${turn.sessionId}:${turn.channel}:${turn.itemId}`
  if (turn.text.trim()) next[key] = turn
  else delete next[key]
  return next
}

/** Retire an old capture/source without discarding another session's pending speech. */
export function clearPartials(previous: PartialCache, sessionId: string, channel?: AudioChannel): PartialCache {
  return Object.fromEntries(Object.entries(previous).filter(([, turn]) => turn.sessionId !== sessionId || (channel !== undefined && turn.channel !== channel)))
}
