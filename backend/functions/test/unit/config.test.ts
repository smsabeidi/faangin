import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { expectLivemode, hostingOrigin, projectId } from '../../src/config.js'

const KEYS = ['FIREBASE_CONFIG', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'STRIPE_EXPECT_LIVEMODE', 'FAANGIN_HOSTING_ORIGIN'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const reset = () => KEYS.forEach((k) => { delete process.env[k] })
const inProject = (id: string) => { reset(); process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: id }) }
afterEach(() => KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))))

describe('project-derived deployment settings', () => {
  it('reads the project from FIREBASE_CONFIG, then GCLOUD_PROJECT, then GOOGLE_CLOUD_PROJECT', () => {
    inProject('faangin-prod')
    assert.equal(projectId(), 'faangin-prod')
    reset(); process.env.FIREBASE_CONFIG = '/not/json/path'; process.env.GCLOUD_PROJECT = 'faangin-staging'
    assert.equal(projectId(), 'faangin-staging')
    reset(); process.env.GOOGLE_CLOUD_PROJECT = 'x'
    assert.equal(projectId(), 'x')
    reset(); assert.equal(projectId(), '')
  })

  it('production expects live events with no env file at all; every other project expects test events', () => {
    inProject('faangin-prod'); assert.equal(expectLivemode(), true)
    inProject('faangin-staging'); assert.equal(expectLivemode(), false)
    inProject('demo-faangin'); assert.equal(expectLivemode(), false)
    reset(); assert.equal(expectLivemode(), false, 'unknown project fails closed to test mode')
  })

  it('STRIPE_EXPECT_LIVEMODE overrides only when it is exactly true or false', () => {
    inProject('faangin-staging'); process.env.STRIPE_EXPECT_LIVEMODE = 'true'; assert.equal(expectLivemode(), true)
    inProject('faangin-prod'); process.env.STRIPE_EXPECT_LIVEMODE = 'false'; assert.equal(expectLivemode(), false)
    inProject('faangin-prod'); process.env.STRIPE_EXPECT_LIVEMODE = 'yes'; assert.equal(expectLivemode(), true, 'a typo does not flip production to test mode')
  })

  it('the hosting origin is the project\'s own site unless overridden, never another environment\'s', () => {
    inProject('faangin-prod'); assert.equal(hostingOrigin(), 'https://faangin-prod.web.app')
    inProject('faangin-staging'); assert.equal(hostingOrigin(), 'https://faangin-staging.web.app')
    inProject('faangin-prod'); process.env.FAANGIN_HOSTING_ORIGIN = 'https://faangin.app'
    assert.equal(hostingOrigin(), 'https://faangin.app')
  })
})
