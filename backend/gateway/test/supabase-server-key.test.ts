import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSupabaseServerKey } from '../src/supabase-server-key.js'

const profiles = ['account', 'edge', 'node'] as const
const namedKey = 'sb_secret_' + 'synthetic_named_fixture'
const oldKey = 'sb_secret_' + 'synthetic_default_fixture'
const singular = 'synthetic_singular_fixture', legacy = 'synthetic_legacy_fixture'
const environment = (values: Record<string, string | undefined>) => {
  const entries = new Map(Object.entries(values))
  return { get: (name: string) => entries.get(name) }
}
const selected = (map: string, name = 'rotated') => environment({
  FAANGIN_SUPABASE_SERVER_KEY_NAME: name,
  SUPABASE_SECRET_KEYS: map,
  SUPABASE_SECRET_KEY: singular,
  SUPABASE_SERVICE_ROLE_KEY: legacy
})

test('explicit named modern key overrides default, singular and legacy in every profile', () => {
  for (const profile of profiles) {
    const env = selected(JSON.stringify({ default: oldKey, rotated: namedKey }))
    assert.equal(resolveSupabaseServerKey(env, profile), namedKey)
    assert.equal(resolveSupabaseServerKey(selected(JSON.stringify({ 'rotation name': namedKey }), 'rotation name'), profile), namedKey)
  }
})

test('explicit selector rejects invalid configuration without fallback or secret-bearing diagnostics', () => {
  const invalid: Array<[string | undefined, string]> = [
    [undefined, 'rotated'], ['not-json-private-fixture', 'rotated'],
    ['null', 'rotated'], ['[]', 'rotated'], ['"private-fixture"', 'rotated'], ['42', 'rotated'],
    ['{}', 'rotated'], ['{}', 'toString'], ['{}', 'constructor'], ['{}', '__proto__'],
    [JSON.stringify({ rotated: null }), 'rotated'],
    [JSON.stringify({ rotated: [] }), 'rotated'],
    [JSON.stringify({ rotated: {} }), 'rotated'],
    [JSON.stringify({ rotated: 123 }), 'rotated'],
    [JSON.stringify({ rotated: '' }), 'rotated'],
    [JSON.stringify({ rotated: '   ' }), 'rotated'],
    [JSON.stringify({ rotated: 'eyJ.synthetic_legacy_jwt.fixture' }), 'rotated'],
    [JSON.stringify({ rotated: 'sb_publishable_synthetic_public_fixture' }), 'rotated'],
    [JSON.stringify({ rotated: namedKey + ' ' }), 'rotated'],
    [JSON.stringify({ rotated: 'sb_secret_' }), 'rotated'],
    [JSON.stringify({ rotated: 'sb_secret_private.fixture' }), 'rotated'],
    [JSON.stringify({ rotated: namedKey }), ''],
    [JSON.stringify({ rotated: namedKey }), ' rotated'],
    [JSON.stringify({ rotated: namedKey }), 'rotated '],
    [JSON.stringify({ rotated: namedKey }), 'rot\nated'],
    [JSON.stringify({ rotated: namedKey }), 'rot\tated'],
    [JSON.stringify({ rotated: namedKey }), 'rot\u0000ated'],
    [JSON.stringify({ rotated: namedKey }), 'rot\u007fated']
  ]
  let genericMessage: string | undefined
  for (const profile of profiles) for (const [map, selector] of invalid) {
    const env = environment({
      FAANGIN_SUPABASE_SERVER_KEY_NAME: selector,
      SUPABASE_SECRET_KEYS: map,
      SUPABASE_SECRET_KEY: singular,
      SUPABASE_SERVICE_ROLE_KEY: legacy
    })
    assert.throws(() => resolveSupabaseServerKey(env, profile), error => {
      assert.ok(error instanceof Error)
      genericMessage ??= error.message
      assert.equal(error.message, genericMessage, 'All explicit failures should use the same generic diagnostic')
      for (const value of [namedKey, oldKey, singular, legacy, 'not-json-private-fixture', 'eyJ.synthetic_legacy_jwt.fixture']) {
        assert.ok(!error.message.includes(value), 'Diagnostic leaked a supplied key or private configuration')
      }
      return true
    })
  }
})

test('explicit selector only accepts own dictionary entries, including safe own special names', () => {
  const name = 'faangin_inherited_rotation_fixture'
  Object.defineProperty(Object.prototype, name, { value: namedKey, configurable: true })
  try {
    for (const profile of profiles) assert.throws(() => resolveSupabaseServerKey(selected('{}', name), profile))
  } finally { delete (Object.prototype as Record<string, unknown>)[name] }
  for (const profile of profiles) {
    const ownSpecial = '{"__proto__":' + JSON.stringify(namedKey) + '}'
    assert.equal(resolveSupabaseServerKey(selected(ownSpecial, '__proto__'), profile), namedKey)
  }
})

test('unspecified account profile preserves default/first-string and truthy fallbacks', () => {
  assert.equal(resolveSupabaseServerKey(environment({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: oldKey, other: namedKey }), SUPABASE_SECRET_KEY: singular }), 'account'), oldKey)
  assert.equal(resolveSupabaseServerKey(environment({ SUPABASE_SECRET_KEYS: JSON.stringify({ number: 123, other: namedKey }), SUPABASE_SECRET_KEY: singular }), 'account'), namedKey)
  assert.equal(resolveSupabaseServerKey(environment({ SUPABASE_SECRET_KEYS: '{', SUPABASE_SECRET_KEY: singular, SUPABASE_SERVICE_ROLE_KEY: legacy }), 'account'), singular)
  assert.equal(resolveSupabaseServerKey(environment({ SUPABASE_SECRET_KEYS: '{"default":""}', SUPABASE_SECRET_KEY: '', SUPABASE_SERVICE_ROLE_KEY: legacy }), 'account'), legacy)
  assert.equal(resolveSupabaseServerKey(environment({}), 'account'), '')
})

test('unspecified edge profile preserves default-only and nullish legacy behavior', () => {
  assert.equal(resolveSupabaseServerKey(environment({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: oldKey }), SUPABASE_SERVICE_ROLE_KEY: legacy }), 'edge'), oldKey)
  assert.equal(resolveSupabaseServerKey(environment({ SUPABASE_SECRET_KEYS: JSON.stringify({ other: namedKey }), SUPABASE_SECRET_KEY: singular, SUPABASE_SERVICE_ROLE_KEY: legacy }), 'edge'), legacy)
  assert.equal(resolveSupabaseServerKey(environment({ SUPABASE_SECRET_KEYS: '{"default":""}', SUPABASE_SERVICE_ROLE_KEY: legacy }), 'edge'), '')
  assert.equal(resolveSupabaseServerKey(environment({ SUPABASE_SECRET_KEYS: '{', SUPABASE_SERVICE_ROLE_KEY: legacy }), 'edge'), legacy)
  assert.equal(resolveSupabaseServerKey(environment({ SUPABASE_SECRET_KEY: singular }), 'edge'), undefined)
})

test('unspecified node profile ignores map and preserves empty singular instead of legacy', () => {
  assert.equal(resolveSupabaseServerKey(environment({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: oldKey }), SUPABASE_SECRET_KEY: singular, SUPABASE_SERVICE_ROLE_KEY: legacy }), 'node'), singular)
  assert.equal(resolveSupabaseServerKey(environment({ SUPABASE_SECRET_KEY: '', SUPABASE_SERVICE_ROLE_KEY: legacy }), 'node'), '')
  assert.equal(resolveSupabaseServerKey(environment({ SUPABASE_SERVICE_ROLE_KEY: legacy }), 'node'), legacy)
  assert.equal(resolveSupabaseServerKey(environment({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: oldKey }) }), 'node'), undefined)
})
