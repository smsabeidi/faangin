import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ActivationPageOptions {
  supabaseUrl: string
  publishableKey: string
  functionsBase: string
  userCode: string
  deviceName: string
  expiresAt: number
}
export interface ActivationLease { url: string; close(): Promise<void> }
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

function page(options: ActivationPageOptions, nonce: string, callbackExpiresAt: number): string {
  const config = JSON.stringify({ supabaseUrl: options.supabaseUrl, publishableKey: options.publishableKey, functionsBase: options.functionsBase, userCode: options.userCode, expiresAt: options.expiresAt, callbackExpiresAt }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Activate Faangin</title><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#f6f7fb;color:#182235;font:16px/1.5 system-ui,sans-serif}main{max-width:480px;margin:7vh auto;padding:32px;background:white;border:1px solid #e0e5ed;border-radius:20px}h1{margin:0 0 8px;font-size:28px}p{color:#566478}code{display:block;padding:12px;background:#eff4ff;border-radius:10px;font-size:28px;letter-spacing:.15em;text-align:center;color:#1d4ed8}label{display:block;margin:16px 0 5px}input,button{font:inherit;width:100%;padding:11px;border:1px solid #c5cedc;border-radius:9px}button{margin-top:16px;background:#2563eb;color:white;cursor:pointer}button:disabled{opacity:.6;cursor:wait}.secondary{background:white;color:#234776}.links{display:flex;gap:12px}.links button{font-size:14px}.status{min-height:24px;margin-top:16px}.error{color:#b42318}[hidden]{display:none!important}@media(max-width:520px){main{margin:16px;padding:24px}}</style></head><body><main><h1>Activate Faangin</h1><p id="instructions">Sign in, then approve this code for <strong>${escapeHtml(options.deviceName)}</strong>. Only approve a code shown in your Faangin app.</p><code id="user-code">${escapeHtml(options.userCode)}</code><form id="login"><label for="email">Email</label><input id="email" type="email" autocomplete="email" required maxlength="254"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required minlength="8"><button id="submit" type="submit">Sign in</button><div class="links"><button class="secondary" id="signup" type="button">Create account</button><button class="secondary" id="reset" type="button">Reset password</button></div><button class="secondary" id="google" type="button" hidden>Continue with Google</button></form><form id="recovery" hidden><label for="new-password">New password</label><input id="new-password" type="password" autocomplete="new-password" required minlength="8"><button type="submit">Save password</button></form><section id="approval" hidden><p id="identity"></p><button id="approve">Approve this device</button><button class="secondary" id="different">Use a different account</button></section><p id="expiry" class="error" role="status" hidden></p><p class="status" id="status" role="status" aria-live="polite"></p><p><small>This temporary page belongs to the Faangin app on this device. Your password goes directly to Supabase. Close this tab when finished.</small></p></main><script nonce="${nonce}">
'use strict';
const config=${config};
let accessToken='', email='', busy=false;
const byId=id=>document.getElementById(id);
const status=(message,error=false)=>{byId('status').textContent=message;byId('status').classList.toggle('error',error)};
const expired=()=>Date.now()>=config.expiresAt;
const callbackExpired=()=>Date.now()>=config.callbackExpiresAt;
const expiredMessage='This sign-in code has expired. Return to Faangin and choose Sign in for a new code. You can still confirm your email or reset your password here while Faangin remains open.';
function showExpiry(){if(callbackExpired()){accessToken='';byId('user-code').hidden=true;byId('instructions').textContent='Return to Faangin and start sign-in again to continue.';byId('login').hidden=true;byId('recovery').hidden=true;byId('approval').hidden=true;byId('expiry').hidden=false;byId('expiry').textContent='This temporary account page has expired. Return to Faangin and choose Sign in to continue.';}else if(expired()){byId('user-code').hidden=true;byId('instructions').textContent='You can finish confirming your email or resetting your password, then start sign-in again in Faangin.';byId('approve').hidden=true;byId('expiry').hidden=false;byId('expiry').textContent=expiredMessage;}}
const lock=value=>{busy=value;document.querySelectorAll('button').forEach(button=>button.disabled=value)};
async function request(url,body,authenticated=false){const response=await fetch(url,{method:body?'POST':'GET',headers:{apikey:config.publishableKey,...(body?{'content-type':'application/json'}:{}),...(authenticated?{Authorization:'Bearer '+accessToken}:{})},...(body?{body:JSON.stringify(body)}:{}),credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(20000)});if(response.ok&&response.status===204)return {};let data;try{data=await response.json()}catch{throw Error('The account service returned an invalid response.')}if(!response.ok)throw Error(data.error?.message||data.msg||data.error_description||data.message||(typeof data.error==='string'?data.error:'The account request could not finish.'));return data}
async function currentUser(){const user=await request(config.supabaseUrl+'/auth/v1/user',null,true);if(!user.id||user.is_anonymous===true||!user.email_confirmed_at)throw Error('Confirm your email address before approving this device.');email=user.email||'your account';return user;}
async function showAccount(){await currentUser();byId('identity').textContent='Signed in as '+email;byId('login').hidden=true;byId('recovery').hidden=true;byId('approval').hidden=false;showExpiry();status(expired()?'Your email is confirmed. Return to Faangin and start sign-in again.':'Check the code above, then approve this device.');}
async function run(operation){if(busy)return;if(callbackExpired()){showExpiry();return;}lock(true);status('Connecting…');try{await operation()}catch(error){status(error instanceof Error?error.message:'Could not connect. Please try again.',true)}finally{lock(false);showExpiry()}}
byId('login').addEventListener('submit',event=>{event.preventDefault();void run(async()=>{const data=await request(config.supabaseUrl+'/auth/v1/token?grant_type=password',{email:byId('email').value.trim(),password:byId('password').value});byId('password').value='';accessToken=data.access_token||'';if(!accessToken)throw Error('Sign-in did not return a session.');await showAccount()})});
byId('signup').onclick=()=>void run(async()=>{if(!byId('login').reportValidity())return;const data=await request(config.supabaseUrl+'/auth/v1/signup?redirect_to='+encodeURIComponent(location.href),{email:byId('email').value.trim(),password:byId('password').value});byId('password').value='';if(data.access_token){accessToken=data.access_token;await showAccount()}else status('Check your email to confirm your account. Keep Faangin open and open the link before this temporary page expires (one hour after sign-in started). If the sign-in code expires, return to Faangin and choose Sign in again after confirming. If an account already exists, use Sign in or Reset password.')});
byId('reset').onclick=()=>void run(async()=>{const value=byId('email').value.trim();if(!value||!byId('email').reportValidity())throw Error('Enter your email address first.');await request(config.supabaseUrl+'/auth/v1/recover?redirect_to='+encodeURIComponent(location.href),{email:value});status('If that account exists, a password reset email is on its way. Keep Faangin open and open the link before this temporary page expires (one hour after sign-in started). This page can reset your password even after the sign-in code expires.')});
byId('google').onclick=()=>{if(callbackExpired()){showExpiry();return;}location.href=config.supabaseUrl+'/auth/v1/authorize?provider=google&redirect_to='+encodeURIComponent(location.href)};
byId('different').onclick=()=>void run(async()=>{try{await request(config.supabaseUrl+'/auth/v1/logout?scope=local',{},true)}finally{accessToken='';email='';byId('login').hidden=false;byId('approval').hidden=true;status('Sign in with the account you want to use.')}});
byId('approve').onclick=()=>void run(async()=>{if(expired())throw Error(expiredMessage);if(!accessToken)throw Error('Sign in again before approving this device.');await request(config.functionsBase+'/deviceCodeApprove',{data:{userCode:config.userCode}},true);byId('approval').hidden=true;status('This device is approved. Return to Faangin to choose or use your plan. You can close this tab.');try{await request(config.supabaseUrl+'/auth/v1/logout?scope=local',{},true)}catch{}accessToken='';email=''});
byId('recovery').addEventListener('submit',event=>{event.preventDefault();void run(async()=>{const next=byId('new-password').value;if(!next||next.length<8)throw Error('Choose a password with at least 8 characters.');const response=await fetch(config.supabaseUrl+'/auth/v1/user',{method:'PUT',headers:{apikey:config.publishableKey,Authorization:'Bearer '+accessToken,'content-type':'application/json'},body:JSON.stringify({password:next}),credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000)});byId('new-password').value='';if(!response.ok)throw Error('The new password could not be saved. Request another reset email and try again.');await showAccount();status(expired()?'Your password has been saved. Return to Faangin and choose Sign in for a new code.':'Your password has been saved. Check the code above, then approve this device.')})});
const fragment=new URLSearchParams(location.hash.slice(1));const returned=fragment.get('access_token');const recovery=fragment.get('type')==='recovery';const authError=fragment.get('error_description');history.replaceState(null,'',location.pathname+location.search);
if(returned){accessToken=returned;void run(async()=>{if(recovery){await currentUser();byId('login').hidden=true;byId('recovery').hidden=false;status('Choose a new password. If your sign-in code has expired, return to Faangin after saving it.')}else await showAccount()})}else if(authError)status(authError,true);
showExpiry();setTimeout(showExpiry,Math.max(0,config.expiresAt-Date.now()));setTimeout(showExpiry,Math.max(0,config.callbackExpiresAt-Date.now()));
void request(config.supabaseUrl+'/auth/v1/settings').then(settings=>{byId('google').hidden=settings.external?.google!==true}).catch(()=>{});
window.addEventListener('pagehide',()=>{accessToken='';email=''});
</script></body></html>`
}

/** A loopback-only callback lasts one hour; approving its device code still expires at expiresAt. */
export async function startActivationServer(options: ActivationPageOptions): Promise<ActivationLease> {
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(options.userCode)) throw new Error('Invalid activation code.')
  const callbackExpiresAt = Date.now() + 60 * 60_000
  const nonce = randomBytes(24).toString('base64')
  const lease = randomBytes(24).toString('base64url')
  let expectedHost = ''
  let closed: Promise<void> | null = null
  const server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('x-content-type-options', 'nosniff')
    if (request.headers.host !== expectedHost) { response.writeHead(403); response.end('Invalid activation host.'); return }
    if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end('Method not allowed.'); return }
    const path = `/activate?code=${options.userCode}&lease=${lease}`
    if (request.url !== path || Date.now() >= callbackExpiresAt) { response.writeHead(404); response.end('This activation page is unavailable. Start sign-in again in Faangin.'); return }
    const origin = new URL(options.supabaseUrl).origin
    response.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src ${origin}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page(options, nonce, callbackExpiresAt))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  expectedHost = `127.0.0.1:${(server.address() as AddressInfo).port}`
  const close = (): Promise<void> => {
    if (closed) return closed
    clearTimeout(timer)
    server.closeAllConnections()
    closed = new Promise<void>(resolve => server.close(() => resolve()))
    return closed
  }
  const timer = setTimeout(() => { void close() }, Math.max(1, callbackExpiresAt - Date.now()))
  timer.unref()
  return { url: `http://${expectedHost}/activate?code=${options.userCode}&lease=${lease}`, close }
}
