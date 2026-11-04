import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Use path semantics for Windows drive letters, separators and parent traversal. */
export function pathWithin(root: string, path: string): string | null {
  const inside = relative(root, path)
  return inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`) ? inside : null
}

/** Packaged windows always use the bundled renderer, including when running QA. */
export function developmentRenderer(packaged: boolean, value: string | undefined): URL | null {
  if (packaged || !value) return null
  try {
    const url = new URL(value.endsWith('/') ? value : `${value}/`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password || url.search || url.hash) return null
    return url
  } catch { return null }
}

/** QA may operate on its own existing temporary directory. Resolve aliases and symlinks first. */
export function smokeProfile(requested: string | undefined, temporaryRoot: string, regularProfile: string): string | null {
  if (!requested || !isAbsolute(requested)) return null
  try {
    const root = realpathSync.native(temporaryRoot)
    const profile = realpathSync.native(requested)
    const regular = canonicalPath(regularProfile)
    if (relative(root, dirname(profile)) || !/^faangin-[\w-]+$/.test(basename(profile))) return null
    if (!relative(regular, profile) || pathWithin(regular, profile) || pathWithin(profile, regular)) return null
    return statSync(profile).isDirectory() ? profile : null
  } catch { return null }
}

export function smokeMarker(requested: string | undefined, profile: string | null): string | null {
  if (!profile || !requested || !isAbsolute(requested)) return null
  const name = basename(requested)
  return /^ready(?:-[\w-]+)?\.json$/.test(name) && sameExistingPath(dirname(requested), profile) ? join(profile, name) : null
}

export function sameExistingPath(path: string, expected: string): boolean {
  try { return relative(realpathSync.native(path), expected) === '' } catch { return false }
}

function canonicalPath(path: string): string {
  try { return realpathSync.native(path) } catch { return resolve(path) }
}
