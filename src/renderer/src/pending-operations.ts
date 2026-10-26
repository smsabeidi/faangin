/** Nested desktop work may finish out of order (for example Stop while Start is connecting). */
export class PendingDesktopOperations {
  private sequence = 0
  private readonly pending = new Map<number, string>()

  begin(label: string): number {
    const id = ++this.sequence
    this.pending.set(id, label)
    return id
  }

  finish(id: number): string {
    this.pending.delete(id)
    return [...this.pending.values()].at(-1) ?? ''
  }
}

export interface RequestOwner { sessionId: string; contextEpoch: number }

/** Keep edits made while transcription settles, and never restore a question into another context. */
export function settledRequestDraft(current: string, submitted: string, succeeded: boolean, owner: RequestOwner | null, currentOwner: RequestOwner | null): string {
  if (!owner || !currentOwner || owner.sessionId !== currentOwner.sessionId || owner.contextEpoch !== currentOwner.contextEpoch) return current
  if (succeeded) return current.trim() === submitted.trim() ? '' : current
  return current || submitted
}
