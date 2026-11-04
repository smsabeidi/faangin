import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { developmentRenderer, smokeMarker, smokeProfile } from '../src/main/desktop-runtime'

test('packaged windows ignore development renderer overrides', () => {
  assert.equal(developmentRenderer(true, 'https://untrusted.example'), null)
  assert.equal(developmentRenderer(false, 'http://localhost:5173')?.href, 'http://localhost:5173/')
  for (const url of ['file:///tmp/renderer', 'https://user:password@localhost', 'https://localhost/?foo=bar', 'not a URL']) {
    assert.equal(developmentRenderer(false, url), null)
  }
})

test('QA requires an existing temporary profile separate from normal data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const temporary = join(root, 'temp'), regular = join(root, 'faangin-regular'), fixture = join(temporary, 'faangin-smoke-abc123')
  const outside = join(root, 'ready.json'), file = join(temporary, 'faangin-file')
  await Promise.all([mkdir(fixture, { recursive: true }), mkdir(regular)])
  await writeFile(file, 'fixture')
  const profile = await realpath(fixture)
  assert.equal(smokeProfile(fixture, temporary, regular), profile)
  assert.equal(smokeProfile(regular, temporary, regular), null)
  assert.equal(smokeProfile(fixture, temporary, fixture), null)
  assert.equal(smokeProfile(fixture, temporary, temporary), null)
  assert.equal(smokeProfile(file, temporary, regular), null)
  assert.equal(smokeProfile(join(temporary, 'faangin-missing'), temporary, regular), null)
  assert.equal(smokeMarker(join(fixture, 'ready-first.json'), profile), join(profile, 'ready-first.json'))
  assert.equal(smokeMarker(join(fixture, 'faangin.sqlite'), profile), null)
  assert.equal(smokeMarker(outside, profile), null)

  const alias = join(temporary, 'faangin-alias')
  await symlink(regular, alias, 'junction')
  assert.equal(smokeProfile(alias, temporary, regular), null)
  assert.equal(smokeMarker(join(alias, 'ready.json'), profile), null)
})
