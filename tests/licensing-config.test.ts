import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedExternalUrl, resolveCloudConfig, type CloudConfig } from '../src/main/licensing/config'

const build = { functionsBase: 'https://us-central1-faangin-staging.cloudfunctions.net', webApiKey: 'web-key' }

test('a build without backend values has no accounts service', () => {
  assert.equal(resolveCloudConfig({ packaged: true }), null)
  assert.equal(resolveCloudConfig({ packaged: true, build: { functionsBase: build.functionsBase, webApiKey: '' } }), null)
  assert.equal(resolveCloudConfig({ packaged: true, build: { functionsBase: '', webApiKey: 'web-key' } }), null)
})

test('the hosting origin is derived from the functions host', () => {
  assert.deepEqual(resolveCloudConfig({ packaged: true, build }), { functionsBase: build.functionsBase, webApiKey: 'web-key', hostingOrigin: 'https://faangin-staging.web.app' })
  assert.equal(resolveCloudConfig({ packaged: true, build: { ...build, functionsBase: 'https://europe-west1-my-proj.cloudfunctions.net/' } })?.hostingOrigin, 'https://my-proj.web.app')
  assert.equal(resolveCloudConfig({ packaged: true, build: { ...build, functionsBase: 'https://api.example.com' } }), null, 'an unrecognised host needs an explicit hosting origin')
  assert.equal(resolveCloudConfig({ packaged: true, build: { ...build, functionsBase: 'https://api.example.com', hostingOrigin: 'https://faangin.app/' } })?.hostingOrigin, 'https://faangin.app')
})

test('packaged builds ignore the environment; development builds honor it', () => {
  const env = { FAANGIN_FUNCTIONS_BASE: 'https://us-central1-other.cloudfunctions.net', FAANGIN_WEB_API_KEY: 'dev-key' }
  assert.equal(resolveCloudConfig({ packaged: true, env, build }) ?.functionsBase, build.functionsBase)
  assert.equal(resolveCloudConfig({ packaged: true, env }), null)
  const dev = resolveCloudConfig({ packaged: false, env, build })
  assert.equal(dev?.functionsBase, env.FAANGIN_FUNCTIONS_BASE)
  assert.equal(dev?.webApiKey, 'dev-key')
  assert.equal(dev?.hostingOrigin, 'https://other.web.app')
})

test('the backend must be https, and the emulator is reachable only from development builds', () => {
  assert.equal(resolveCloudConfig({ packaged: true, build: { ...build, functionsBase: 'http://us-central1-faangin-staging.cloudfunctions.net' } }), null)
  const emulator = { functionsBase: 'http://127.0.0.1:5001/demo-faangin/us-central1', webApiKey: 'fake-api-key' }
  assert.equal(resolveCloudConfig({ packaged: true, build: emulator }), null)
  const config = resolveCloudConfig({ packaged: false, build: emulator })
  assert.equal(config?.hostingOrigin, 'http://localhost:5000')
  assert.match(config?.identityToolkitBase ?? '', /^http:\/\/127\.0\.0\.1:9099\//)
  assert.match(config?.secureTokenBase ?? '', /^http:\/\/127\.0\.0\.1:9099\//)
  assert.equal(resolveCloudConfig({ packaged: true, build }) ?.identityToolkitBase, undefined)
})

test('a non-local hosting origin must be https', () => {
  assert.equal(resolveCloudConfig({ packaged: true, build: { ...build, hostingOrigin: 'http://faangin.app' } }), null)
  assert.equal(resolveCloudConfig({ packaged: true, build: { ...build, hostingOrigin: 'not a url' } }), null)
})

const config: CloudConfig = { functionsBase: build.functionsBase, webApiKey: 'web-key', hostingOrigin: 'https://faangin-staging.web.app' }

test('only the activation page and Stripe-hosted pages are opened from server links', () => {
  assert.equal(allowedExternalUrl('https://faangin-staging.web.app/activate?code=ABCD-EFGH', config, 'activate'), 'https://faangin-staging.web.app/activate?code=ABCD-EFGH')
  assert.equal(allowedExternalUrl('https://evil.example/activate?code=ABCD-EFGH', config, 'activate'), null)
  assert.equal(allowedExternalUrl('http://faangin-staging.web.app/activate', config, 'activate'), null)
  assert.equal(allowedExternalUrl('https://checkout.stripe.com/c/pay/cs_test_1', config, 'checkout'), 'https://checkout.stripe.com/c/pay/cs_test_1')
  assert.equal(allowedExternalUrl('https://billing.stripe.com/p/session/test_1', config, 'portal'), 'https://billing.stripe.com/p/session/test_1')
  assert.equal(allowedExternalUrl('https://billing.stripe.com/p/session/test_1', config, 'checkout'), null)
  assert.equal(allowedExternalUrl('https://checkout.stripe.com/c/pay/cs_test_1', config, 'portal'), null)
  assert.equal(allowedExternalUrl('http://checkout.stripe.com/c/pay/cs_test_1', config, 'checkout'), null)
  assert.equal(allowedExternalUrl('https://checkout.stripe.com.evil.example/c/pay', config, 'checkout'), null)
  assert.equal(allowedExternalUrl('javascript:alert(1)', config, 'checkout'), null)
  assert.equal(allowedExternalUrl('not a url', config, 'activate'), null)
})
