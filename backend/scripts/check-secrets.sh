#!/usr/bin/env bash
# Fails when a Stripe key, webhook secret, OpenAI key, private key (PEM, or the base64 DER LICENSE_SIGNING_KEY) or service-account
# file is in a tracked file, an untracked file that is not ignored, or a staged blob. Runs first in `npm test`; also usable as a
# pre-commit hook: ln -s ../../scripts/check-secrets.sh .git/hooks/pre-commit
set -euo pipefail
cd "$(git rev-parse --show-toplevel)" # not dirname "$0": as a symlinked hook that would resolve inside .git/
pattern='(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|(^|[^A-Za-z0-9_])sk-(proj-)?[A-Za-z0-9_-]{32,}|MC4CAQAwBQYDK2VwBCIE[A-Za-z0-9+/=]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key_id"'
# git grep is NUL-safe (spaces and non-ASCII in names). Exit 1 means no match; anything above is a real failure and must not read as "clean".
scan() {
  local rc=0 out
  out=$(git grep -n -I -E "$@" -e "$pattern" -- . ':!scripts/check-secrets.sh') || rc=$?
  if [ "$rc" -gt 1 ]; then echo "check-secrets: git grep failed ($rc)" >&2; exit 2; fi
  printf '%s' "$out"
}
hits=$(scan --untracked; printf '\n'; scan --cached)
hits=$(printf '%s\n' "$hits" | grep . | sort -u || true)
if [ -n "$hits" ]; then
  echo "check-secrets: a secret is in a tracked, untracked or staged file:" >&2
  echo "$hits" | sed -E 's/((sk|rk|pk)_(live|test)_[A-Za-z0-9]{6})[A-Za-z0-9]+/\1…/g; s/(whsec_[A-Za-z0-9]{4})[A-Za-z0-9]+/\1…/g; s/(sk-(proj-)?[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/\1…/g; s/(MC4CAQAwBQYDK2VwBCIE)[A-Za-z0-9+\/=]+/\1…/g' >&2
  exit 1
fi
echo "check-secrets: clean ($( (git ls-files; git ls-files --others --exclude-standard) | grep -c .) files)"
