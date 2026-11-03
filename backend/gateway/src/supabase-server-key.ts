/** Pure shared selection for hosted Edge and the optional Node runtime. */
export interface SupabaseKeyEnvironment { get(name: string): string | undefined }
export type SupabaseServerKeyProfile = 'account' | 'edge' | 'node'

/**
 * A configured name is a deliberate modern-key cutover: never silently select another
 * credential. Unconfigured deployments retain each entrypoint's existing fallback order.
 */
export function resolveSupabaseServerKey(env: SupabaseKeyEnvironment, profile: SupabaseServerKeyProfile): string | undefined {
  const selectedName = env.get('FAANGIN_SUPABASE_SERVER_KEY_NAME')
  if (selectedName !== undefined) {
    const unavailable = () => new Error('The selected Supabase server key is unavailable')
    if (!selectedName || selectedName !== selectedName.trim() || /[\x00-\x1f\x7f]/.test(selectedName)) throw unavailable()
    let keys: unknown
    try { keys = JSON.parse(env.get('SUPABASE_SECRET_KEYS') ?? '') } catch { throw unavailable() }
    if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !Object.hasOwn(keys, selectedName)) throw unavailable()
    const value = (keys as Record<string, unknown>)[selectedName]
    if (typeof value !== 'string' || !/^sb_secret_[A-Za-z0-9_-]+$/.test(value)) throw unavailable()
    return value
  }

  if (profile !== 'node') {
    const raw = env.get('SUPABASE_SECRET_KEYS')
    if (raw) {
      try {
        const keys = JSON.parse(raw) as Record<string, unknown>
        const value = typeof keys.default === 'string' ? keys.default
          : profile === 'account' ? Object.values(keys).find(item => typeof item === 'string') : undefined
        if (typeof value === 'string' && (profile === 'edge' || value)) return value
      } catch { /* Preserve the pre-selector fallback for existing deployments. */ }
    }
  }
  if (profile === 'account') return env.get('SUPABASE_SECRET_KEY') || env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  return profile === 'node' ? env.get('SUPABASE_SECRET_KEY') ?? env.get('SUPABASE_SERVICE_ROLE_KEY') : env.get('SUPABASE_SERVICE_ROLE_KEY')
}
