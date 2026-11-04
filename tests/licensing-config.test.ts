import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedExternalUrl, resolveCloudConfig, type CloudConfig } from '../src/main/licensing/config'
const build = { supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' }
const config: CloudConfig = { ...build, functionsBase: `${build.supabaseUrl}/functions/v1/faangin-api` }

test('a backend-free development build remains unavailable', () => {
  assert.equal(resolveCloudConfig({ packaged: false }), null)
  assert.equal(resolveCloudConfig({ packaged: true, build: { ...build, publishableKey: '' } }), null)
  assert.equal(resolveCloudConfig({ packaged: true, build: { ...build, publishableKey: 'sb_secret_forbidden' } }), null)
})
test('Supabase account routes are derived and runtime overrides are development-only', () => {
  assert.deepEqual(resolveCloudConfig({ packaged: true, build }), config)
  const env = { FAANGIN_SUPABASE_URL: 'https://other.supabase.co', FAANGIN_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_other' }
  assert.deepEqual(resolveCloudConfig({ packaged: true, env, build }), config)
  assert.equal(resolveCloudConfig({ packaged: false, env, build })?.functionsBase, 'https://other.supabase.co/functions/v1/faangin-api')
})
test('production account endpoints use HTTPS and never accept loopback or credentials', () => {
  for (const supabaseUrl of ['http://fixture.supabase.co', 'http://127.0.0.1:54321', 'https://user:pass@fixture.supabase.co', 'https://fixture.supabase.co/path', 'https://fixture.supabase.co?token=x']) assert.equal(resolveCloudConfig({ packaged: true, build: { ...build, supabaseUrl } }), null)
  assert.equal(resolveCloudConfig({ packaged: false, build: { ...build, supabaseUrl: 'http://127.0.0.1:54321' } })?.functionsBase, 'http://127.0.0.1:54321/functions/v1/faangin-api')
})
test('Pro gateway Edge paths and environment public signing keys are supported', () => {
  const configured = { ...build, gatewayBase: `${build.supabaseUrl}/functions/v1/faangin-gateway`, licensePublicKeys: ['build-key'] }
  const env = { FAANGIN_GATEWAY_BASE: 'https://other.example.run.app', FAANGIN_LICENSE_PUBLIC_KEYS: 'current,next' }
  assert.equal(resolveCloudConfig({ packaged: true, build: configured, env })?.gatewayBase, configured.gatewayBase)
  assert.deepEqual(resolveCloudConfig({ packaged: true, build: configured, env })?.licensePublicKeys, ['build-key'])
  assert.deepEqual(resolveCloudConfig({ packaged: false, build: configured, env })?.licensePublicKeys, ['current', 'next'])
  for (const gatewayBase of ['http://gateway.example.com', 'https://user:pass@gateway.example.com', 'https://gateway.example.com?secret=1']) assert.equal(resolveCloudConfig({ packaged: true, build: { ...build, gatewayBase } }), null)
})
test('server billing links accept only the matching Stripe host without credentials', () => {
  assert.equal(allowedExternalUrl('https://checkout.stripe.com/c/pay/test', config, 'checkout'), 'https://checkout.stripe.com/c/pay/test')
  assert.equal(allowedExternalUrl('https://billing.stripe.com/p/session/test', config, 'portal'), 'https://billing.stripe.com/p/session/test')
  for (const url of ['https://evil.example/pay', 'https://user@checkout.stripe.com/pay', 'https://checkout.stripe.com.evil.example/pay', 'http://checkout.stripe.com/pay', 'javascript:alert(1)']) assert.equal(allowedExternalUrl(url, config, 'checkout'), null)
  assert.equal(allowedExternalUrl('https://billing.stripe.com/p/session/test', config, 'checkout'), null)
})
