const MAX_SELECTED_IMAGES = 4

/** Keep image consent independent of the focused window and current attachment list. */
export class AttachmentSelection {
  private readonly sessions = new Map<string, string[]>()

  set(sessionId: string, selectedIds: readonly string[], availableIds: readonly string[]): string[] {
    if (selectedIds.length > MAX_SELECTED_IMAGES) throw new Error('Select at most four images for one request.')
    if (new Set(selectedIds).size !== selectedIds.length) throw new Error('An image was selected more than once.')
    const available = new Set(availableIds)
    if (selectedIds.some(id => !available.has(id))) throw new Error('A selected image is no longer available in this session.')
    this.sessions.set(sessionId, [...selectedIds])
    return this.get(sessionId)
  }

  get(sessionId: string): string[] {
    return [...(this.sessions.get(sessionId) ?? [])]
  }

  validateRequested(sessionId: string, requestedIds: readonly string[], availableIds: readonly string[]): string[] {
    if (requestedIds.length > MAX_SELECTED_IMAGES) throw new Error('Select at most four images for one request.')
    if (new Set(requestedIds).size !== requestedIds.length) throw new Error('An image was selected more than once.')
    const selected = new Set(this.get(sessionId)), available = new Set(availableIds)
    if (requestedIds.some(id => !selected.has(id) || !available.has(id))) {
      throw new Error('Screenshot selection changed. Refresh the workspace and reselect images before requesting assistance.')
    }
    return [...requestedIds]
  }

  added(sessionId: string, id: string): string[] {
    const selected = this.get(sessionId)
    if (!selected.includes(id) && selected.length < MAX_SELECTED_IMAGES) selected.push(id)
    this.sessions.set(sessionId, selected)
    return this.get(sessionId)
  }

  removed(sessionId: string, id: string): string[] {
    const selected = this.get(sessionId).filter(selectedId => selectedId !== id)
    this.sessions.set(sessionId, selected)
    return this.get(sessionId)
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
