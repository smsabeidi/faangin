import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

// Execute the actual hosted-page script with only the Firebase and DOM boundaries replaced.
function activatePage() {
  const html = readFileSync(new URL('../../../hosting/activate.html', import.meta.url), 'utf8')
  class Element {
    value = ''
    textContent = ''
    disabled = false
    onclick?: () => void
    hidden = new Set<string>(['hidden'])
    classList = { toggle: (name: string, on: boolean) => on ? this.hidden.add(name) : this.hidden.delete(name) }
    constructor(readonly plan?: string) {}
    getAttribute() { return this.plan }
    click() { if (!this.disabled) this.onclick?.() }
  }
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]))
  const plans = ['byok', 'pro_monthly', 'pro_annual'].map((plan) => new Element(plan))
  const buttons = ['google', 'emailSignIn', 'resetPassword', 'approve', 'portal', 'signout'].map((id) => elements[id]).concat(plans)
  const resets: string[] = []
  const checkouts: string[] = []
  let authChanged: (user: unknown) => void = () => {}
  const auth = {
    currentUser: null as null | { uid: string; email: string },
    useEmulator() {},
    onAuthStateChanged(callback: typeof authChanged) { authChanged = callback; callback(null) },
    async sendPasswordResetEmail(email: string) { resets.push(email) },
    async signOut() { this.currentUser = null; authChanged(null) }
  }
  const functions = {
    useEmulator() {},
    httpsCallable(name: string) {
      return async (data: { plan?: string }) => {
        if (name === 'createCheckoutSession') checkouts.push(data.plan!)
        return { data: { deviceName: 'Test Mac', url: 'https://checkout.stripe.test/session' } }
      }
    }
  }
  runInNewContext(html.match(/<script>\s*([\s\S]*?)<\/script>/)![1], {
    firebase: { auth: () => auth, app: () => ({ functions: () => functions }) },
    document: { getElementById: (id: string) => elements[id], querySelectorAll: (selector: string) => selector === 'button' ? buttons : plans },
    location: { hostname: 'localhost', search: '?code=ABCD-EFGH' }, URLSearchParams
  })
  const signIn = (uid: string) => { auth.currentUser = { uid, email: `${uid}@example.test` }; authChanged(auth.currentUser) }
  const settled = () => new Promise((resolve) => setImmediate(resolve))
  return { elements, plans, resets, checkouts, signIn, settled }
}

test('hosted account recovery sends a password reset and restores controls', async () => {
  const page = activatePage()
  page.elements.email.value = ' buyer@example.test '
  page.elements.resetPassword.click()
  assert.equal(page.elements.emailSignIn.disabled, true)
  await page.settled()
  assert.deepEqual(page.resets, ['buyer@example.test'])
  assert.equal(page.elements.resetSent.hidden.has('hidden'), false)
  assert.equal(page.elements.emailSignIn.disabled, false)
})

test('hosted approval resets when the account changes and parallel checkout clicks are ignored', async () => {
  const page = activatePage()
  page.signIn('buyer-a')
  page.elements.approve.click()
  await page.settled()
  assert.equal(page.elements.codeInput.disabled, true)
  assert.equal(page.elements.plans.hidden.has('hidden'), false)
  page.signIn('buyer-b')
  assert.equal(page.elements.approve.hidden.has('hidden'), false)
  assert.equal(page.elements.codeInput.disabled, false)
  assert.equal(page.elements.plans.hidden.has('hidden'), true)
  page.plans[0].click()
  page.plans[1].click()
  await page.settled()
  assert.deepEqual(page.checkouts, ['byok'])
})
