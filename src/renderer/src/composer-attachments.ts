/** Overlay selection stays explicit without opening a thumbnail tray on every new capture. */
export function attachmentTrayVisible(compact: boolean, selectedCount: number, explicitlyExpanded: boolean): boolean {
  return explicitlyExpanded || (!compact && selectedCount > 0)
}

export function attachmentSelectionSummary(selectedCount: number, totalCount: number): string {
  return selectedCount > 0
    ? `${selectedCount} screenshot${selectedCount === 1 ? '' : 's'} selected`
    : `${totalCount} saved screenshot${totalCount === 1 ? '' : 's'} · none selected`
}
