/** Session ownership is separate from presentation and transport cancellation. */
export class CaptureFence {
  private nextGeneration = 0
  private owner: { generation: number; sessionId: string; epoch: number; active: boolean; closingUntil: number } | null = null
  begin(sessionId: string, epoch: number): number {
    const generation = ++this.nextGeneration
    this.owner = { generation, sessionId, epoch, active: true, closingUntil: 0 }
    return generation
  }
  acceptsFrames(generation: number): boolean { return !!this.owner?.active && this.owner.generation === generation }
  acceptsResult(generation: number, sessionId: string, epoch: number, now = Date.now()): boolean {
    const o = this.owner
    return !!o && o.generation === generation && o.sessionId === sessionId && o.epoch === epoch && (o.active || now <= o.closingUntil)
  }
  stop(now = Date.now()): number | null {
    if (!this.owner?.active) return null
    this.owner.active = false; this.owner.closingUntil = now + 5000
    return this.owner.generation
  }
  invalidate(): void { this.nextGeneration++; this.owner = null }
}
