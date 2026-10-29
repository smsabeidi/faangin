/** Current documented Responses image support and latency-conscious reasoning defaults.
 * Saved model choices are retained; unknown text models still use their provider defaults.
 */
export function supportsImageInput(model: string): boolean {
  return /^gpt-4\.1(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model) ||
    /^(?:gpt-6-(?:luna|sol|astra)|gpt-6\.1-sol)$/.test(model)
}

export function answerReasoning(model: string, effort?: 'none' | 'low'): { reasoning: { effort: 'none' | 'low' } } | Record<string, never> {
  if (model === 'gpt-6-luna') return { reasoning: { effort: effort ?? 'none' } }
  if (model === 'gpt-6-sol') return { reasoning: { effort: 'none' } }
  if (model === 'gpt-6-astra' || model === 'gpt-6.1-sol') return { reasoning: { effort: 'low' } }
  return {}
}
