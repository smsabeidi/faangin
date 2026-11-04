import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = dirname(fileURLToPath(import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'faangin-billing-sql-'))
const cluster = join(directory, 'cluster'), socket = join(directory, 'socket'), port = '55491'
await mkdir(socket, { mode: 0o700 })
let started = false
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, ...options, stdio: options.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'] })
    let output = '', error = ''
    child.stdout?.on('data', chunk => output += chunk)
    child.stderr?.on('data', chunk => error += chunk)
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`${command} failed (${code}): ${error || output}`)))
    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
  })
}
try {
  await run('initdb', ['-D', cluster, '-A', 'trust', '-U', 'postgres'])
  await run('pg_ctl', ['-D', cluster, '-o', `-h '' -k ${socket} -p ${port} -c shared_buffers=16MB -c max_connections=20`, '-l', join(directory, 'server.log'), '-w', 'start'])
  started = true
  const schema = await readFile(join(root, 'schema-billing.sql'), 'utf8')
  await run('psql', ['-h', socket, '-p', port, '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: 'create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);\n' + schema })
  await run('npm', ['test'], { inherit: true, env: { ...process.env, FAANGIN_TEST_PG_SOCKET: socket } })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  if (started) await run('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop']).catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
