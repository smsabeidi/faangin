import { useState, type ReactNode } from 'react'
import { ArrowUpRight, Check, Copy, CreditCard, LogOut, RefreshCw, X } from 'lucide-react'
import type { BillingPlan, BillingSummary, LicensedPlan } from '../../../shared/billing-types'
import { Spinner } from '../components'
import { useBilling } from './useBilling'

// These mirror the Stripe catalog in backend/scripts/stripe-setup.mjs; the server picks the real price per plan.
const PLAN_OFFERS: { plan: BillingPlan; label: string; detail: string }[] = [
  { plan: 'byok', label: 'BYOK license', detail: '$10 once · use your own OpenAI key' },
  { plan: 'pro_monthly', label: 'Pro monthly', detail: '$14.99 per month · Faangin supplies the models' },
  { plan: 'pro_annual', label: 'Pro yearly', detail: '$144 per year' }
]
const PLAN_NAMES: Record<LicensedPlan, string> = { byok: 'BYOK license', pro: 'Pro' }

const dateOf = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })

export function BillingPanel() {
  const billing = useBilling()
  const { summary } = billing
  const error = billing.actionError ?? summary?.error ?? null
  return <section className="settings-card billing-card">
    <div className="settings-card-heading"><span><CreditCard size={18}/></span><div><h2>Plan & account</h2><p>Sign in to activate a Faangin plan on this Mac.</p></div></div>
    <div className="settings-card-body">
      {error && <p className="billing-error" role="alert">{error}</p>}
      {!summary ? <Spinner label="Loading"/> : <Body summary={summary} billing={billing}/>}
    </div>
  </section>
}

function Body({ summary, billing }: { summary: BillingSummary; billing: ReturnType<typeof useBilling> }) {
  const { state, busy } = summary
  switch (state.kind) {
    case 'unavailable':
      return <p className="billing-muted">This build of Faangin is not connected to an accounts service. Everything else keeps working with your own OpenAI key.</p>
    case 'signed-out':
      return summary.signIn ? <SignInCode summary={summary} billing={billing}/> : <>
        <p>Sign in once with your browser. This Mac is registered to your account; one account can use up to three devices.</p>
        <div className="billing-actions"><button className="button primary small" disabled={busy} onClick={() => { void billing.signIn() }}><ArrowUpRight size={14}/>Sign in</button></div>
      </>
    case 'no-plan':
      return <>
        <p>You are signed in, and no plan is active on this account yet.</p>
        <Offers summary={summary} billing={billing}/>
        <Footer summary={summary} billing={billing} check/>
      </>
    case 'active':
      return <>
        <div className="billing-plan-row"><strong>{PLAN_NAMES[state.plan]}</strong><span className="connection-badge connected"><span className="status-dot"/>{state.pastDue ? 'Payment failed' : 'Active'}</span></div>
        {state.plan === 'byok' && <p className="billing-muted">Licensed on this Mac.</p>}
        {state.plan === 'pro' && state.periodEnd !== null && <p className="billing-muted">{state.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {dateOf(state.periodEnd)}</p>}
        {state.pastDue && <p className="billing-warning">Your last payment failed. Update your card in Manage billing; access continues while Stripe retries.</p>}
        <div className="billing-actions"><button className="button subtle small" disabled={busy} onClick={() => { void billing.manage() }}><ArrowUpRight size={14}/>Manage billing</button></div>
        {state.plan === 'byok' && <Offers summary={summary} billing={billing} only={['pro_monthly', 'pro_annual']} title="Add Pro"/>}
        <Footer summary={summary} billing={billing}/>
      </>
    case 'grace':
      return <>
        <div className="billing-plan-row"><strong>{PLAN_NAMES[state.plan]}</strong><span className="connection-badge"><span className="status-dot"/>Needs a check</span></div>
        <p>Your license is past its 30-day check but keeps working until {dateOf(state.graceUntil)}. Reconnect to refresh it.</p>
        <Footer summary={summary} billing={billing} check/>
      </>
    case 'locked':
      return <>
        <div className="billing-plan-row"><strong>License expired</strong><span className="connection-badge danger"><span className="status-dot"/>Reconnect</span></div>
        <p>This Mac could not refresh its license in time. Check again while online, or sign out and back in.</p>
        <Footer summary={summary} billing={billing} check/>
      </>
  }
}

function SignInCode({ summary, billing }: { summary: BillingSummary; billing: ReturnType<typeof useBilling> }) {
  const [copied, setCopied] = useState(false)
  const prompt = summary.signIn!
  return <>
    <p>Your browser opened the sign-in page. Confirm this code there:</p>
    <div className="billing-code-row" aria-live="polite">
      <code className="billing-code">{prompt.userCode}</code>
      <button className="button subtle small" onClick={() => { void navigator.clipboard?.writeText(prompt.userCode).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {}) }}>{copied ? <Check size={13}/> : <Copy size={13}/>}{copied ? 'Copied' : 'Copy code'}</button>
    </div>
    <p className="billing-muted">Waiting for approval… <a href={prompt.verificationUrl} target="_blank" rel="noreferrer">Open the page again</a></p>
    <button className="text-button danger-text" onClick={() => { void billing.cancelSignIn() }}><X size={13}/>Cancel sign-in</button>
  </>
}

function Offers({ summary, billing, only, title }: { summary: BillingSummary; billing: ReturnType<typeof useBilling>; only?: BillingPlan[]; title?: string }) {
  return <div className="billing-offers">
    {title && <h3>{title}</h3>}
    {PLAN_OFFERS.filter(offer => !only || only.includes(offer.plan)).map(offer => <div key={offer.plan} className="billing-offer">
      <div><strong>{offer.label}</strong><span className="billing-muted">{offer.detail}</span></div>
      <button className="button primary small" disabled={summary.busy} onClick={() => { void billing.checkout(offer.plan) }}><ArrowUpRight size={14}/>Buy</button>
    </div>)}
    {summary.awaitingPurchase && <p className="billing-muted">Finish checkout in your browser. Faangin checks again when you return to the app.</p>}
  </div>
}

function Footer({ summary, billing, check }: { summary: BillingSummary; billing: ReturnType<typeof useBilling>; check?: boolean }): ReactNode {
  return <div className="billing-footer">
    {summary.deviceName && <span className="billing-muted">This Mac: {summary.deviceName}</span>}
    <div className="billing-actions">
      {check && <button className="button subtle small" disabled={summary.busy} onClick={() => { void billing.refresh() }}>{summary.busy ? <Spinner label="Checking"/> : <><RefreshCw size={14}/>Check again</>}</button>}
      <button className="text-button danger-text" onClick={() => { void billing.signOut() }}><LogOut size={13}/>Sign out</button>
    </div>
  </div>
}
