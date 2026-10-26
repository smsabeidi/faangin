interface SessionAttachment {
  id: string
  sessionId: string
}

export interface OrderedAttachments<T extends SessionAttachment> {
  attachments: T[]
  selectedIds: string[]
}

/** Validate the whole tray before changing either its order or image consent. */
export function reorderSessionAttachments<T extends SessionAttachment>(
  sessionId: string,
  attachments: readonly T[],
  orderedIds: readonly string[],
  selectedIds: readonly string[]
): OrderedAttachments<T> {
  const available = new Map<string, T>()
  for (const attachment of attachments) {
    if (attachment.sessionId !== sessionId) throw new Error('An image belongs to a different session.')
    if (available.has(attachment.id)) throw new Error('The image tray contains a repeated image.')
    available.set(attachment.id, attachment)
  }
  if (orderedIds.length !== attachments.length) throw new Error('Image order changed. Refresh the workspace before reordering images.')
  if (new Set(orderedIds).size !== orderedIds.length) throw new Error('An image was reordered more than once.')
  if (orderedIds.some(id => !available.has(id))) throw new Error('An image in this order is no longer available in this session.')
  if (selectedIds.length > 4) throw new Error('Select at most four images for one request.')
  if (new Set(selectedIds).size !== selectedIds.length) throw new Error('An image was selected more than once.')
  if (selectedIds.some(id => !available.has(id))) throw new Error('A selected image is no longer available in this session.')

  const selected = new Set(selectedIds)
  return {
    attachments: orderedIds.map(id => available.get(id)!),
    selectedIds: orderedIds.filter(id => selected.has(id))
  }
}
