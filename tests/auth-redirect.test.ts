import assert from 'node:assert/strict'
import test from 'node:test'
import { GOOGLE_AUTH_REDIRECT, isGoogleAuthCallback } from '../src/main/licensing/auth-redirect'

test('desktop app-link routing accepts only the configured Google callback target', () => {
  assert.equal(isGoogleAuthCallback(`${GOOGLE_AUTH_REDIRECT}?code=fixture-code`), true)
  assert.equal(isGoogleAuthCallback(`${GOOGLE_AUTH_REDIRECT}#error=access_denied`), true)
  for (const value of [
    '--faangin://auth/callback?code=fixture-code',
    'faangin://someone@auth/callback?code=fixture-code',
    'faangin://auth:80/callback?code=fixture-code',
    'faangin://auth/path/../callback?code=fixture-code',
    'faangin://auth/callback/extra?code=fixture-code',
    'faangin://auth/other?code=fixture-code',
    'https://auth/callback?code=fixture-code',
    `${GOOGLE_AUTH_REDIRECT}?code=line\nbreak`,
    `${GOOGLE_AUTH_REDIRECT}?code=${'x'.repeat(8192)}`
  ]) assert.equal(isGoogleAuthCallback(value), false, value.slice(0, 90))
})
