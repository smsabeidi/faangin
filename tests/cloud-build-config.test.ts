import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error Node executes this build helper directly; it has no declaration file.
import { readCloudBuildConfig } from '../scripts/cloud-build-config.mjs'

test('release configuration requires real public metadata and rejects credentials and local endpoints', () => {
  const directory = mkdtempSync(join(tmpdir(), 'faangin-build-config-'))
  const path = join(directory, 'cloud.json')
  const key = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const config = { supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture', gatewayBase: 'https://fixture.supabase.co/functions/v1/faangin-gateway', licensePublicKeys: [key] }
  const read = (value: unknown) => { writeFileSync(path, JSON.stringify(value)); return readCloudBuildConfig(path, { required: true }) }
  try {
    assert.equal(readCloudBuildConfig(undefined), undefined)
    assert.throws(() => readCloudBuildConfig(undefined, { required: true }), /FAANGIN_CLOUD_CONFIG_FILE/)
    assert.deepEqual(read(config), config)
    assert.throws(() => read({ ...config, OPENAI_API_KEY: 'never-bundle-a-secret' }), /unsupported fields/)
    assert.throws(() => read({ ...config, gatewayBase: 'http://localhost:8080' }), /public HTTPS/)
    assert.throws(() => read({ ...config, supabaseUrl: 'https://user:password@example.com' }), /public HTTPS/)
    assert.throws(() => read({ ...config, gatewayBase: 'https://example.com/route' }), /configured Supabase project/)
    assert.throws(() => read({ ...config, publishableKey: 'server-only-secret' }), /publishable key/)
    const withoutGateway = { ...config, gatewayBase: undefined }
    assert.equal(read(withoutGateway).gatewayBase, config.gatewayBase)
    assert.throws(() => read({ ...config, licensePublicKeys: ['REPLACE_ME'] }), /Ed25519/)
    assert.throws(() => read({ ...config, licensePublicKeys: [] }), /public keys/)
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})
