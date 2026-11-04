// `--import` preload for npm run test:win32: the unit tests run with process.platform reporting win32 so the
// Windows branches execute on a macOS or Linux host. Only the platform string changes; `path` keeps the host's
// separators because Node chose them at boot, before any preload runs.
import { tmpdir } from 'node:os'

// Node's os.tmpdir() takes the Windows branch once it sees win32 and then returns TEMP/TMP, falling back to a
// literal 'undefined\temp' on a host that sets neither. Pinning both to the real directory first keeps tsx and
// every mkdtemp() in the real temp folder.
const realTmpdir = tmpdir()
process.env.TEMP = realTmpdir
process.env.TMP = realTmpdir
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true, enumerable: true })
// Third-party code that rewrites paths from process.platform (jiti under app-builder-lib) breaks against the host's
// posix `path`; the one test that loads it skips itself when this is set, while a real Windows run never sets it.
process.env.FAANGIN_SIMULATED_PLATFORM = 'win32'
console.log('Simulating process.platform=win32 for tests')
