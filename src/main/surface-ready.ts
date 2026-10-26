type SurfaceListener = (...args: unknown[]) => void

export interface SurfaceContents {
  isLoading(): boolean
  isDestroyed(): boolean
  on(event: string, listener: SurfaceListener): unknown
  removeListener(event: string, listener: SurfaceListener): unknown
}

/** Bound renderer startup and release listeners when loading, cancellation, or failure wins. */
export function waitForSurface(contents: SurfaceContents, signal: AbortSignal, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finished: SurfaceListener = () => settle()
    const failed: SurfaceListener = (...args) => {
      if (args[4] === false) return
      settle(new Error('The desktop surface could not load.'))
    }
    const crashed: SurfaceListener = () => settle(new Error('The desktop surface closed before loading completed.'))
    const destroyed: SurfaceListener = () => settle(new Error('The desktop surface was destroyed before loading completed.'))
    const aborted = (): void => settle(signal.reason ?? new Error('Loading the desktop surface was cancelled.'))
    const listeners: Array<[string, SurfaceListener]> = [
      ['did-finish-load', finished], ['did-fail-load', failed], ['render-process-gone', crashed], ['destroyed', destroyed]
    ]

    function settle(error?: unknown): void {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      for (const [event, listener] of listeners) contents.removeListener(event, listener)
      signal.removeEventListener('abort', aborted)
      if (error === undefined) resolve()
      else reject(error)
    }

    try {
      if (signal.aborted) { aborted(); return }
      if (contents.isDestroyed()) { destroyed(); return }
      if (!contents.isLoading()) { settle(); return }
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) { settle(new Error('The desktop surface load deadline is invalid.')); return }
      for (const [event, listener] of listeners) contents.on(event, listener)
      signal.addEventListener('abort', aborted, { once: true })
      timer = setTimeout(() => settle(new Error('Loading the desktop surface timed out. Try restarting capture.')), timeoutMs)
      // Recheck after listeners are attached so completion or cancellation cannot strand startup.
      if (signal.aborted) aborted()
      else if (contents.isDestroyed()) destroyed()
      else if (!contents.isLoading()) finished()
    } catch (error) { settle(error) }
  })
}
