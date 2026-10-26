import type { Answer } from '../../shared/types'

/** A new manual request may replace automatic work, but never duplicates manual work. */
export function manualGenerationBlocked(answers: ReadonlyArray<Pick<Answer, 'status' | 'origin'>>, pendingDesktopOperation = false): boolean {
  return pendingDesktopOperation || answers.some(answer => answer.status === 'streaming' && answer.origin !== 'automatic')
}
