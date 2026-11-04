import type { CaptureCommand, PlatformId } from '../shared/types'

/**
 * The OS the main process runs on, carried by every capture command because this sandboxed renderer cannot
 * read process.platform. A malformed value keeps today's macOS copy and behaviour rather than failing capture.
 */
export function commandPlatform(command: CaptureCommand): PlatformId {
  const { platform } = command
  return platform === 'win32' || platform === 'linux' ? platform : 'darwin'
}
