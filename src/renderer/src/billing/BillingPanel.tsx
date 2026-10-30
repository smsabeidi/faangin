/**
 * Billing section rendered inside Settings. Shows the current plan,
 * usage, and the device-code sign-in / sign-out / portal controls.
 *
 * Copy is intentionally in a top-level COPY const so a translator can
 * replace it in one place without a round trip through React tree.
 */

import { useCallback, useMemo, type ReactElement } from 'react'
import { ArrowUpRight, CheckCircle2, Copy, Loader2, LogOut, RefreshCw, ShieldCheck, X } from 'lucide-react'
import type { Entitlement, Plan, ProUsageSnapshot } from '../../../shared/billing-types'
import type { BillingSummary } from '../../../preload/billing'
import { useLicenseState } from './useLicenseState'

const COPY = {
  heading: 'Plan & billing',
  subheading: 'Your Faangin plan, usage, and sign-in state.',
  noneTitle: 'Not signed in',
  noneBody: 'Sign in to activate a paid plan on this Mac. Three devices per entitlement.',
  signIn: 'Sign in on faangin.app',
  cancelSignIn: 'Cancel sign-in',
  copyCode: 'Copy code',
  copyCodeCopied: 'Copied',
  activeTitle: 'Active',
  graceTitle: 'In grace period',
  graceBody: 'Your license has expired but a 14-day grace window is in effect. Reconnect to refresh.',
  expiredTitle: 'Expired',
  expiredBody: 'This device has not been able to refresh its license for over 44 days. Sign in again to renew.',
  revokedTitle: 'License no longer valid',
  revokedBody: 'This license was canceled, refunded, or revoked. Sign in with a current account to continue.',
  renew: 'Renew',
  signInAgain: 'Sign in again',
  manage: 'Manage subscription',
  signOut: 'Sign out',
  refresh: 'Refresh now',
  usageHeading: 'This period',
  deviceId: 'Device fingerprint',
  verificationHint: 'Open the sign-in page and enter this code:',
  codeInstructionsFallback: 'You can also follow this link:',
  errorPrefix: 'Billing error:',
  loading: 'Loading billing status…',
  bridgeMissing: 'Billing is not available in this window.',
}

const PLAN_LABELS: Record<Plan, string> = {
  byok: 'BYOK · $10 one-time',
  pro_monthly: 'Pro · $14.99 / month',
  pro_yearly: 'Pro · $144 / year',
}

export function BillingPanel(): ReactElement {
  const license = useLicenseState()
  const { state, summary, signInStart, isLoading, error } = license

  const onCopyCode = useCallback(() => {
    if (!signInStart) return
    void navigator.clipboard?.writeText(signInStart.userCode).catch(() => {})
  }, [signInStart])

  const body = useMemo(() => {
    if (isLoading && !summary) return <p className="billing-muted">{COPY.loading}</p>
    if (!window.billing) return <p className="billing-muted">{COPY.bridgeMissing}</p>

    switch (state.kind) {
      case 'none':
        return <NoneState signInStart={signInStart} onSignIn={license.signIn} onCancel={license.cancelSignIn} onCopy={onCopyCode}/>
      case 'active':
        return <ActiveState entitlement={summary?.entitlement ?? null} usage={summary?.usage ?? null} renewsAt={state.renewsAt} deviceId={summary?.deviceId ?? null} onManage={license.openManage} onSignOut={license.signOut}/>
      case 'grace':
        return <GraceState entitlement={summary?.entitlement ?? null} graceUntil={state.graceUntil} onRefresh={license.refresh} onManage={license.openManage} onSignOut={license.signOut}/>
      case 'expired':
        return <ExpiredState plan={state.plan} onSignIn={license.signIn} onSignOut={license.signOut}/>
      case 'revoked':
        return <RevokedState onSignIn={license.signIn} onSignOut={license.signOut}/>
    }
  }, [state, summary, signInStart, isLoading, license, onCopyCode])

  return (
    <section className="settings-card billing-card">
      <div className="settings-card-heading">
        <span><ShieldCheck size={18}/></span>
        <div>
          <h2>{COPY.heading}</h2>
          <p>{COPY.subheading}</p>
        </div>
      </div>
      <div className="settings-card-body">
        {error && <p className="billing-error" role="alert">{COPY.errorPrefix} {error}</p>}
        {body}
      </div>
    </section>
  )
}

interface SignOutProps { onSignOut: () => Promise<void> }

function NoneState({ signInStart, onSignIn, onCancel, onCopy }: {
  signInStart: ReturnType<typeof useLicenseState>['signInStart']
  onSignIn: () => Promise<void>
  onCancel: () => Promise<void>
  onCopy: () => void
}): ReactElement {
  if (!signInStart) {
    return (
      <div>
        <h3 className="billing-section-title">{COPY.noneTitle}</h3>
        <p>{COPY.noneBody}</p>
        <button className="button primary small" onClick={() => { void onSignIn() }}><ArrowUpRight size={14}/>{COPY.signIn}</button>
      </div>
    )
  }
  return (
    <div>
      <h3 className="billing-section-title">{COPY.noneTitle}</h3>
      <p>{COPY.verificationHint}</p>
      <div className="billing-code-row" aria-live="polite">
        <code className="billing-user-code">{signInStart.userCode}</code>
        <button type="button" className="button subtle small" onClick={onCopy}><Copy size={13}/>{COPY.copyCode}</button>
      </div>
      <p className="billing-muted">{COPY.codeInstructionsFallback} <a href={signInStart.verificationUriComplete} target="_blank" rel="noreferrer">{signInStart.verificationUri}</a></p>
      <button className="text-button danger-text" onClick={() => { void onCancel() }}><X size={13}/>{COPY.cancelSignIn}</button>
    </div>
  )
}

function ActiveState({ entitlement, usage, renewsAt, deviceId, onManage, onSignOut }: {
  entitlement: Entitlement | null
  usage: ProUsageSnapshot | null
  renewsAt: number
  deviceId: string | null
  onManage: () => Promise<void>
  onSignOut: () => Promise<void>
}): ReactElement {
  return (
    <div>
      <div className="billing-plan-row">
        <h3 className="billing-section-title">{COPY.activeTitle}</h3>
        <span className="connection-badge connected"><span className="status-dot"/>{entitlement ? PLAN_LABELS[entitlement.plan] : 'Active'}</span>
      </div>
      <p className="billing-muted">Renews {formatDate(renewsAt)}</p>
      {usage && entitlement && entitlement.plan !== 'byok' && <UsageBars usage={usage}/>}
      <DeviceLine deviceId={deviceId}/>
      <div className="billing-actions">
        {entitlement?.plan !== 'byok' && <button className="button subtle small" onClick={() => { void onManage() }}><ArrowUpRight size={14}/>{COPY.manage}</button>}
        <SignOutButton onSignOut={onSignOut}/>
      </div>
    </div>
  )
}

function GraceState({ entitlement, graceUntil, onRefresh, onManage, onSignOut }: {
  entitlement: Entitlement | null
  graceUntil: number
  onRefresh: () => Promise<void>
  onManage: () => Promise<void>
} & SignOutProps): ReactElement {
  return (
    <div>
      <div className="billing-plan-row">
        <h3 className="billing-section-title">{COPY.graceTitle}</h3>
        <span className="connection-badge"><span className="status-dot"/>Grace ends {formatDate(graceUntil)}</span>
      </div>
      <p>{COPY.graceBody}{entitlement ? ` Plan: ${PLAN_LABELS[entitlement.plan]}.` : ''}</p>
      <div className="billing-actions">
        <button className="button primary small" onClick={() => { void onRefresh() }}><RefreshCw size={14}/>{COPY.refresh}</button>
        {entitlement?.plan !== 'byok' && <button className="button subtle small" onClick={() => { void onManage() }}><ArrowUpRight size={14}/>{COPY.manage}</button>}
        <SignOutButton onSignOut={onSignOut}/>
      </div>
    </div>
  )
}

function ExpiredState({ plan, onSignIn, onSignOut }: {
  plan: Plan
  onSignIn: () => Promise<void>
} & SignOutProps): ReactElement {
  return (
    <div>
      <div className="billing-plan-row">
        <h3 className="billing-section-title">{COPY.expiredTitle}</h3>
        <span className="connection-badge danger"><span className="status-dot"/>{PLAN_LABELS[plan]}</span>
      </div>
      <p>{COPY.expiredBody}</p>
      <div className="billing-actions">
        <button className="button primary small" onClick={() => { void onSignIn() }}><ArrowUpRight size={14}/>{COPY.renew}</button>
        <SignOutButton onSignOut={onSignOut}/>
      </div>
    </div>
  )
}

function RevokedState({ onSignIn, onSignOut }: { onSignIn: () => Promise<void> } & SignOutProps): ReactElement {
  return (
    <div>
      <div className="billing-plan-row">
        <h3 className="billing-section-title">{COPY.revokedTitle}</h3>
        <span className="connection-badge danger"><span className="status-dot"/>Revoked</span>
      </div>
      <p>{COPY.revokedBody}</p>
      <div className="billing-actions">
        <button className="button primary small" onClick={() => { void onSignIn() }}><ArrowUpRight size={14}/>{COPY.signInAgain}</button>
        <SignOutButton onSignOut={onSignOut}/>
      </div>
    </div>
  )
}

function SignOutButton({ onSignOut }: SignOutProps): ReactElement {
  return <button className="text-button danger-text" onClick={() => { void onSignOut() }}><LogOut size={13}/>{COPY.signOut}</button>
}

function DeviceLine({ deviceId }: { deviceId: string | null }): ReactElement | null {
  if (!deviceId) return null
  return <p className="billing-muted billing-device"><CheckCircle2 size={12}/>{COPY.deviceId}: <code>{deviceId.slice(0, 12)}…</code></p>
}

function UsageBars({ usage }: { usage: ProUsageSnapshot }): ReactElement {
  const rows: Array<{ label: string; used: number; cap: number; unit: string }> = [
    { label: 'Transcribed audio', used: usage.transcribedSeconds, cap: usage.transcribedBudgetSeconds, unit: 'sec' },
    { label: 'Hands-free requests', used: usage.handsFreeCount, cap: usage.handsFreeBudget, unit: '' },
    { label: 'Fast requests', used: usage.fastCount, cap: usage.fastBudget, unit: '' },
    { label: 'Smart requests', used: usage.smartCount, cap: usage.smartBudget, unit: '' },
  ]
  return (
    <div className="billing-usage">
      <h4 className="billing-usage-title">{COPY.usageHeading}</h4>
      {rows.map(row => {
        const ratio = row.cap > 0 ? Math.min(1, row.used / row.cap) : 0
        return (
          <div key={row.label} className="billing-usage-row">
            <div className="billing-usage-row-head"><span>{row.label}</span><span className="billing-muted">{Math.round(row.used)}{row.unit && ` ${row.unit}`} / {row.cap}</span></div>
            <div className="billing-usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={row.cap} aria-valuenow={row.used}><span style={{ width: `${ratio * 100}%` }}/></div>
          </div>
        )
      })}
    </div>
  )
}

function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return 'unknown'
  try {
    return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return 'unknown'
  }
}

// Keep this import non-dead so lucide-react icon used only in a conditional path survives tree-shake inspection.
export const _iconHints = [Loader2]
