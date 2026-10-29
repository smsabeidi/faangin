export interface ManualPreparation {
  readonly sessionId: string
  readonly revision: number
}

/** Revokes async request preparation independently from already-running transport ownership. */
export class ManualPreparationFence {
  private revision = 0
  private active: ManualPreparation | null = null
  begin(sessionId: string): ManualPreparation {
    if (!sessionId) throw new Error('Answer preparation requires a session.')
    if (this.active) throw new Error('The latest question is still being finalized. Wait for the current answer request to start.')
    const preparation = Object.freeze({ sessionId, revision: ++this.revision })
    this.active = preparation
    return preparation
  }
  current(preparation: ManualPreparation): boolean { return this.active === preparation }
  assertCurrent(preparation: ManualPreparation): void {
    if (!this.current(preparation)) throw new Error('The answer request was cancelled. Answer latest again when you are ready.')
  }
  cancel(sessionId?: string): void {
    if (!sessionId || this.active?.sessionId === sessionId) this.active = null
  }
  release(preparation: ManualPreparation): void {
    if (this.current(preparation)) this.active = null
  }
}
