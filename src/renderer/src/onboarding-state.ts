import type { AppState, WorkspaceMode } from '../../shared/types'

export const ONBOARDING_STORAGE_KEY = 'faangin.onboarding.v1'
export interface OnboardingProgress { step: number; mode: WorkspaceMode; completed: boolean }
type OnboardingStorage = Pick<Storage, 'getItem' | 'setItem'>
const initialProgress = (): OnboardingProgress => ({ step: 0, mode: 'interview', completed: false })

function browserStorage(): OnboardingStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage } catch { return undefined }
}

/** Local UI preferences never block opening the workspace if storage is unavailable. */
export function readOnboarding(storage: OnboardingStorage | undefined = browserStorage()): OnboardingProgress {
  try {
    const value: unknown = JSON.parse(storage?.getItem(ONBOARDING_STORAGE_KEY) || 'null')
    if (!value || typeof value !== 'object') return initialProgress()
    const progress = value as Partial<OnboardingProgress>
    if (!Number.isInteger(progress.step) || progress.step! < 0 || progress.step! > 3 || !['meeting', 'interview'].includes(progress.mode || '') || typeof progress.completed !== 'boolean') return initialProgress()
    return { step: progress.step!, mode: progress.mode!, completed: progress.completed }
  } catch { return initialProgress() }
}

export function saveOnboarding(progress: OnboardingProgress, storage: OnboardingStorage | undefined = browserStorage()): void {
  try { storage?.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(progress)) } catch { /* Setup remains usable in a read-only browser profile. */ }
}

export function completeOnboarding(mode: WorkspaceMode, storage: OnboardingStorage | undefined = browserStorage()): void {
  saveOnboarding({ step: 3, mode, completed: true }, storage)
}

export function shouldShowOnboarding(state: Pick<AppState, 'windowKind' | 'sessions' | 'chatConfigured'>, storage: OnboardingStorage | undefined = browserStorage()): boolean {
  const progress = readOnboarding(storage)
  return state.windowKind === 'workspace' && !progress.completed && (progress.step > 0 || state.sessions.length === 0 || !state.chatConfigured)
}
