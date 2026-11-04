#!/usr/bin/env bash
# Scan working files and staged blobs. Report locations only: never print credential text.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
node <<'NODE'
const { spawnSync } = require('node:child_process')
const { readFileSync, lstatSync } = require('node:fs')
function git(args) {
  const result = spawnSync('git', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed`)
  return result.stdout
}
const excluded = new Set(['scripts/check-secrets.sh', 'backend/scripts/check-secrets.sh'])
const patterns = [
  /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /whsec_[A-Za-z0-9]{16,}/,
  /(?:^|[^A-Za-z0-9_])sk-(?:proj-)?[A-Za-z0-9_-]{32,}/,
  /MC4CAQAwBQYDK2VwBCIE[A-Za-z0-9+/=]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /"private_key_id"/,
  /sb_secret_[A-Za-z0-9_-]{16,}/,
  /(?:^|[^A-Za-z0-9_])sbp_[A-Za-z0-9_-]{20,}/
]
function privateJwt(line) {
  for (const token of line.matchAll(/eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    try { if (JSON.parse(Buffer.from(token[1], 'base64url').toString('utf8')).role === 'service_role') return true } catch {}
  }
  return false
}
const safePath = path => JSON.stringify(patterns.reduce((value, pattern) => value.replace(new RegExp(pattern.source, 'g'), '[credential]'), path).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]'))
const hits = new Set()
function scan(path, content, staged = false) {
  if (excluded.has(path) || content.includes(0)) return
  const lines = content.toString('utf8').split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (patterns.some(pattern => pattern.test(lines[index])) || privateJwt(lines[index])) {
      hits.add(`${safePath(path)}:${index + 1}${staged ? ' (staged)' : ''}`)
    }
  }
}
try {
  const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean))]
  for (const path of files) {
    try { if (lstatSync(path).isFile()) scan(path, readFileSync(path)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  for (const entry of git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean)) {
    const match = /^[0-7]+ ([0-9a-f]+) [0-3]\t([\s\S]+)$/.exec(entry)
    if (!match) throw new Error('Unrecognized staged entry')
    if (!excluded.has(match[2])) scan(match[2], git(['cat-file', 'blob', match[1]]), true)
  }
  if (hits.size) {
    console.error('check-secrets: credentials detected; remove them from these working/staged locations:')
    for (const hit of [...hits].sort()) console.error(hit)
    process.exitCode = 1
  } else console.log(`check-secrets: clean (${files.length} files plus staged versions)`)
} catch (error) {
  console.error(`check-secrets: scan failed (${error.message})`)
  process.exitCode = 2
}
NODE
