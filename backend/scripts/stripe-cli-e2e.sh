#!/usr/bin/env bash
# Real Stripe events, signed by Stripe, into the emulated stripeWebhook. Needs the Stripe CLI (STRIPE_CLI=path or `stripe`
# on PATH) and the sandbox key in .env.stripe-sandbox. Swaps functions/.secret.local for the run, and does so while holding the
# emulator lock, so no other emulator user ever sees or backs up the swapped file (restored on exit): the functions talk to the
# real sandbox (subscriptions.retrieve) and verify signatures with `stripe listen`'s secret.
# Triggers create test objects in the sandbox (tagged metadata.faangin_e2e=1) and the script removes them afterwards.
# After a SIGKILL mid-run, `node scripts/dev-secrets.mjs --force` resets functions/.secret.local to the emulator fakes.
#
#   scripts/stripe-cli-e2e.sh            (serialized with the other emulator users through with-emulator-lock.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
STRIPE_BIN="${STRIPE_CLI:-$(command -v stripe || true)}"
[ -x "$STRIPE_BIN" ] || { echo "stripe CLI not found; set STRIPE_CLI=/path/to/stripe" >&2; exit 1; }
[ -f .env.stripe-sandbox ] || { echo ".env.stripe-sandbox missing" >&2; exit 1; }
STRIPE_API_KEY=$(sed -n 's/^STRIPE_SANDBOX_SECRET_KEY=//p' .env.stripe-sandbox | tr -d '[:space:]')
case "$STRIPE_API_KEY" in sk_test_*|rk_test_*) ;; *) echo "sandbox-only: refusing a non-test key" >&2; exit 1;; esac
export STRIPE_API_KEY
UID_E2E="e2e_$(date +%s)"
LOG=$(mktemp -d)
START_TS=$(date +%s)
SECRET=functions/.secret.local

run_inside_emulators() {
  "$STRIPE_BIN" listen --api-key "$STRIPE_API_KEY" --forward-to http://127.0.0.1:5001/demo-faangin/us-central1/stripeWebhook \
    --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.paused,customer.subscription.resumed,invoice.paid,invoice.payment_failed,charge.refunded,charge.dispute.created,radar.early_fraud_warning.created \
    > "$LOG/listen.log" 2>&1 &
  local listen_pid=$!
  for _ in $(seq 1 40); do grep -q "Ready" "$LOG/listen.log" && break; sleep 1; done
  grep -q "Ready" "$LOG/listen.log" || { echo "stripe listen never became ready:"; cat "$LOG/listen.log"; kill $listen_pid || true; return 1; }
  echo "--- trigger customer.subscription.created (pro_monthly for $UID_E2E) ---"
  "$STRIPE_BIN" trigger customer.subscription.created --api-key "$STRIPE_API_KEY" \
    --add "subscription:metadata.uid=$UID_E2E" --add subscription:metadata.plan=pro_monthly --add subscription:metadata.faangin_e2e=1 \
    --add customer:metadata.faangin_e2e=1 --add product:metadata.faangin_e2e=1 2>&1 | tail -2
  echo "--- trigger checkout.session.completed (byok for $UID_E2E) ---"
  "$STRIPE_BIN" trigger checkout.session.completed --api-key "$STRIPE_API_KEY" \
    --add "checkout_session:metadata.uid=$UID_E2E" --add checkout_session:metadata.plan=byok --add "checkout_session:client_reference_id=$UID_E2E" \
    --add product:metadata.faangin_e2e=1 2>&1 | tail -2
  sleep 15
  echo "--- stripe listen deliveries ---"
  grep -E '^\s*[0-9:-]+\s+-->|<--|\[[0-9]{3}\]' "$LOG/listen.log" || cat "$LOG/listen.log"
  echo "--- entitlements/$UID_E2E (read as the emulator owner; rules deny clients) ---"
  curl -s -H "Authorization: Bearer owner" "http://127.0.0.1:8080/v1/projects/demo-faangin/databases/(default)/documents/entitlements/$UID_E2E" | python3 -I -c '
import sys, json
d = json.load(sys.stdin)
def v(x):
    if "stringValue" in x: return x["stringValue"]
    if "integerValue" in x: return int(x["integerValue"])
    if "doubleValue" in x: return x["doubleValue"]
    if "booleanValue" in x: return x["booleanValue"]
    if "mapValue" in x: return {k: v(val) for k, val in x["mapValue"].get("fields", {}).items()}
    return x
print(json.dumps({k: v(val) for k, val in d.get("fields", {}).items()}, indent=1) if "fields" in d else d)'
  echo "--- stripeEvents (type → outcome) ---"
  curl -s -H "Authorization: Bearer owner" "http://127.0.0.1:8080/v1/projects/demo-faangin/databases/(default)/documents/stripeEvents?pageSize=100" | python3 -I -c '
import sys, json
for doc in json.load(sys.stdin).get("documents", []):
    f = doc["fields"]; print(doc["name"].split("/")[-1], f.get("type", {}).get("stringValue"), "→", f.get("outcome", {}).get("stringValue", "(unprocessed)"))'
  kill $listen_pid 2>/dev/null || true
}
# Runs while holding the emulator lock: swap the secrets file, run the emulators, restore the file even on failure.
locked_run() {
  node scripts/dev-secrets.mjs >/dev/null
  BACKUP=$(mktemp)
  cp "$SECRET" "$BACKUP"
  trap 'cp "$BACKUP" "$SECRET"; rm -f "$BACKUP"; echo "restored $SECRET"' EXIT
  {
    echo "STRIPE_CHECKOUT_KEY=$STRIPE_API_KEY"
    echo "STRIPE_WEBHOOK_KEY=$STRIPE_API_KEY"
    echo "STRIPE_WEBHOOK_SECRET=$WHSEC"
    grep -E '^LICENSE_' "$BACKUP"
  } > "$SECRET"
  npm --prefix functions run build >/dev/null
  node_modules/.bin/firebase emulators:exec --project demo-faangin --only auth,firestore,functions "bash -c run_inside_emulators"
}
export -f run_inside_emulators locked_run
export STRIPE_BIN UID_E2E LOG SECRET

WHSEC=$("$STRIPE_BIN" listen --api-key "$STRIPE_API_KEY" --print-secret)
export WHSEC
scripts/with-emulator-lock.sh bash -c locked_run 2>&1 \
  | tee "$LOG/emulator.log" | grep -E '^---|→|^\{|^ |^\}|stripeWebhook|-->|<--|Ready|Trigger|error|Error|warn|restored' | grep -v -E 'functions: Loaded|Beginning execution|Finished' || true

echo "--- sandbox cleanup (objects tagged faangin_e2e since $START_TS) ---"
node - "$START_TS" <<'JS'
import { Stripe } from './scripts/lib/stripe-env.mjs'
const stripe = new Stripe(process.env.STRIPE_API_KEY)
const since = Number(process.argv[2]) - 60
let customers = 0, subscriptions = 0, products = 0
for await (const c of stripe.customers.list({ created: { gte: since }, limit: 100 })) {
  if (c.metadata?.faangin_e2e !== '1') continue
  for await (const s of stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 100 })) {
    if (!['canceled', 'incomplete_expired'].includes(s.status)) { await stripe.subscriptions.cancel(s.id); subscriptions++ }
  }
  await stripe.customers.del(c.id); customers++
}
for await (const p of stripe.products.list({ created: { gte: since }, active: true, limit: 100 })) {
  if (p.metadata?.faangin_e2e !== '1') continue
  for await (const pr of stripe.prices.list({ product: p.id, active: true, limit: 100 })) await stripe.prices.update(pr.id, { active: false })
  await stripe.products.update(p.id, { active: false }); products++
}
console.log(`canceled ${subscriptions} subscription(s), deleted ${customers} customer(s), archived ${products} product(s)`)
JS
echo "logs: $LOG"
