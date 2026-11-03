import { randomUUID } from 'node:crypto'
import { createLiveTranscriber, InferenceError, type LiveTranscriber, type TranscriberOptions } from './inference'

export interface ManagedTranscriberOptions extends TranscriberOptions {
  /** Supabase Free workers retire after 150s; rotate well before that boundary. */
  rotationMs?: number
  maxBufferedMs?: number
  createTranscriber?: typeof createLiveTranscriber
  /** Refresh the account token before opening the next managed socket. */
  beforeReconnect?: () => Promise<void>
}
type Buffered = { pcm: Uint8Array } | { complete: boolean }

/** Planned reconnects only; frames already sent to a provider are never replayed. */
export async function createManagedTranscriber(options: ManagedTranscriberOptions): Promise<LiveTranscriber> {
  const factory = options.createTranscriber ?? createLiveTranscriber
  const rotationMs = Math.min(options.rotationMs ?? 90_000, 100_000)
  const maxBufferedBytes = Math.floor((options.maxBufferedMs ?? 15_000) * 48)
  if (!Number.isFinite(rotationMs) || rotationMs < 1 || !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 4800 || maxBufferedBytes > 1_440_000) throw new Error('Invalid managed transcription limits')
  const prefix = randomUUID().slice(0, 12)
  let sequence = 0, activeGeneration = 0
  let active: LiveTranscriber | undefined, admission: AbortController | undefined
  let rotating: Promise<void> | undefined, stopping: Promise<void> | undefined
  let stopped = false, ended = false, failed = false, queuedBytes = 0
  let renewalRequested = false
  let heldFinal: { id: string; at: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const buffered: Buffered[] = []
  const clearTimer = () => { clearTimeout(timer); timer = undefined }
  function fail(message: string): void {
    if (failed || ended) return
    failed = true; clearTimer(); admission?.abort()
    if (queuedBytes) options.onIncomplete?.('Speech buffered during the managed connection change could not be finalized. Review the transcript.')
    buffered.length = 0; queuedBytes = 0
    options.onError(message)
    void active?.stop().catch(() => {})
  }
  function arm(): void {
    clearTimer()
    if (!stopped && !failed) timer = setTimeout(() => { void rotate() }, rotationMs)
  }
  async function connect(): Promise<void> {
    await options.beforeReconnect?.()
    if (stopped || failed) return
    const generation = ++sequence
    const controller = new AbortController(); admission = controller
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) controller.abort()
    let expiring = false
    activeGeneration = generation
    const id = (item: string) => `${prefix}_${generation}_${item}`
    try {
      const next = await factory({ ...options, signal: controller.signal, managedTranscription: true,
        deadlines: { ...options.deadlines, finalizeMs: Math.min(options.deadlines?.finalizeMs ?? 3500, 3500), closeMs: Math.min(options.deadlines?.closeMs ?? 250, 250) },
        onPartial: (item, text, at) => { if (!ended && activeGeneration === generation) options.onPartial(id(item), text, at) },
        onFinal: (item, text, at, complete) => {
          if (ended || activeGeneration !== generation) return
          heldFinal = complete ? undefined : { id: id(item), at }
          options.onFinal(id(item), text, at, complete)
        },
        onUtteranceComplete: (item, at) => {
          if (ended || activeGeneration !== generation) return
          if (heldFinal?.id === id(item)) heldFinal = undefined
          options.onUtteranceComplete?.(id(item), at)
        },
        onSilentEndpoint: () => {
          if (ended || activeGeneration !== generation || !heldFinal) return
          const held = heldFinal; heldFinal = undefined
          options.onUtteranceComplete?.(held.id, held.at)
        },
        onError: message => { if (activeGeneration === generation) fail(message) },
        onSessionExpiring: () => { if (ended || activeGeneration !== generation) return; expiring = true; renewalRequested = true; if (active && !rotating) queueMicrotask(() => { void rotate() }) }
      })
      if (stopped || failed) { await next.stop(); return }
      active = next
      if (expiring) queueMicrotask(() => { void rotate() })
    } finally {
      options.signal?.removeEventListener('abort', abort)
      if (admission === controller) admission = undefined
    }
  }
  async function rotate(): Promise<void> {
    if (stopped || failed) return
    if (rotating) return rotating
    clearTimer(); renewalRequested = false
    const previous = active; active = undefined
    rotating = (async () => {
      if (previous) {
        // Start finalization, then let stop own its bounded drain; an unacknowledged commit is never resent.
        let flushTimer: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([previous.flush(false).catch(() => {}), new Promise<void>(resolve => { flushTimer = setTimeout(resolve, 1000) })]) }
        finally { clearTimeout(flushTimer) }
        await previous.stop()
      }
      if (stopped || failed) return
      await connect()
      if (!active || stopped || failed) return
      const next = active as LiveTranscriber
      while (buffered.length && !stopped && !failed) {
        const item = buffered.shift()!
        if ('pcm' in item) { queuedBytes -= item.pcm.byteLength; next.write(item.pcm) }
        else next.commit(item.complete)
      }
      arm()
    })().catch(() => { if (!stopped) fail('The managed transcription connection could not be renewed. Restart listening and review the transcript.') }).finally(() => {
      rotating = undefined
      if (renewalRequested && !stopped && !failed) { clearTimer(); timer = setTimeout(() => { void rotate() }, 100) }
    })
    return rotating
  }
  try { await connect(); if (!active || failed) throw new InferenceError('offline', 'Managed transcription did not become ready.'); arm() }
  catch (error) { ended = true; clearTimer(); throw error }
  return {
    write(pcm) {
      if (stopped || failed || !pcm.byteLength) return
      if (active && !rotating) { active.write(pcm); return }
      if (queuedBytes + pcm.byteLength > maxBufferedBytes || buffered.length >= 1024) return fail('Managed transcription could not reconnect before its audio buffer filled. Restart listening.')
      buffered.push({ pcm: Uint8Array.from(pcm) }); queuedBytes += pcm.byteLength
    },
    commit(complete = true) {
      if (stopped || failed) return
      if (active && !rotating) return active.commit(complete)
      if (buffered.length >= 1024) return fail('Managed transcription exceeded its pending turn limit. Restart listening.')
      buffered.push({ complete })
    },
    async flush(utteranceComplete = true) {
      if (rotating) await rotating
      if (!active || stopped || failed) throw new InferenceError('offline', 'Managed question audio is disconnected. Restart listening or type the question.')
      await active.flush(utteranceComplete)
    },
    stop() {
      if (stopping) return stopping
      stopped = true; clearTimer(); admission?.abort()
      if (queuedBytes) options.onIncomplete?.('Listening stopped while the managed connection was changing. Buffered speech could not be finalized; review the transcript.')
      buffered.length = 0; queuedBytes = 0
      stopping = (async () => { if (rotating) await rotating; await active?.stop(); ended = true })()
      return stopping
    }
  }
}
