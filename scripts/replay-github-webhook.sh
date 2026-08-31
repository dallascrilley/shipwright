#!/usr/bin/env bash
# Replay a signed GitHub webhook delivery against a running Shipwright instance.
# Signing matches ui/server/routes/api/github/webhook.post.spec.ts (HMAC-SHA256, sha256= prefix).
set -euo pipefail

SHIPWRIGHT_WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:-}"
REVIEWER_WEBHOOK_SECRET="${SYMPHONY_REVIEWER_GITHUB_WEBHOOK_SECRET:-}"
unset GITHUB_WEBHOOK_SECRET
unset SYMPHONY_REVIEWER_GITHUB_WEBHOOK_SECRET
export -n SHIPWRIGHT_WEBHOOK_SECRET REVIEWER_WEBHOOK_SECRET

usage() {
  cat <<'EOF'
Usage: replay-github-webhook.sh [options]

Required:
  GITHUB_WEBHOOK_SECRET   Shipwright App secret for issues-family events.
  SYMPHONY_REVIEWER_GITHUB_WEBHOOK_SECRET
                          Reviewer App secret for pull_request events.
                          Only the secret selected by -e is required.

Options (env or flags):
  -u URL                  Webhook URL (default: http://127.0.0.1:8787/api/github/webhook)
  -d DELIVERY_ID          X-GitHub-Delivery (default: u1-proof-<timestamp>)
  -e EVENT                X-GitHub-Event: issues | pull_request (default: issues)
  -f PAYLOAD_JSON         Path to JSON body (default: issues minimal fixture)
  --replay                POST twice with the same delivery id (idempotency smoke)

Fixtures (repo-relative):
  test/fixtures/github-webhook/issues-opened-minimal.json
  test/fixtures/github-webhook/pull-request-opened-minimal.json

Example (loopback on pin, after SHIPWRIGHT_ROLLOUT_STAGE=dry_run):
  export GITHUB_WEBHOOK_SECRET='...'
  ./scripts/replay-github-webhook.sh -u "http://127.0.0.1:8787/api/github/webhook" --replay
EOF
}

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
URL="${WEBHOOK_URL:-http://127.0.0.1:8787/api/github/webhook}"
DELIVERY_ID="${DELIVERY_ID:-}"
EVENT="${GITHUB_EVENT:-issues}"
PAYLOAD_FILE="${PAYLOAD_FILE:-$ROOT/test/fixtures/github-webhook/issues-opened-minimal.json}"
REPLAY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    -u) URL="$2"; shift 2 ;;
    -d) DELIVERY_ID="$2"; shift 2 ;;
    -e) EVENT="$2"; shift 2 ;;
    -f) PAYLOAD_FILE="$2"; shift 2 ;;
    --replay) REPLAY=true; shift ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! -f "$PAYLOAD_FILE" ]]; then
  echo "Payload file not found: $PAYLOAD_FILE" >&2
  exit 2
fi

if [[ "$EVENT" != "issues" && "$EVENT" != "pull_request" ]]; then
  echo "EVENT must be issues or pull_request (got: $EVENT)" >&2
  exit 2
fi

if [[ "$EVENT" == "pull_request" && "$PAYLOAD_FILE" == *issues-opened-minimal* ]]; then
  PAYLOAD_FILE="$ROOT/test/fixtures/github-webhook/pull-request-opened-minimal.json"
fi

if [[ "$EVENT" == "pull_request" ]]; then
  WEBHOOK_SECRET="$REVIEWER_WEBHOOK_SECRET"
  SECRET_NAME="SYMPHONY_REVIEWER_GITHUB_WEBHOOK_SECRET"
else
  WEBHOOK_SECRET="$SHIPWRIGHT_WEBHOOK_SECRET"
  SECRET_NAME="GITHUB_WEBHOOK_SECRET"
fi
unset SHIPWRIGHT_WEBHOOK_SECRET REVIEWER_WEBHOOK_SECRET

if [[ -z "$WEBHOOK_SECRET" ]]; then
  echo "$SECRET_NAME is required for event $EVENT" >&2
  exit 2
fi

if [[ -z "$DELIVERY_ID" ]]; then
  DELIVERY_ID="u1-proof-$(date -u +%Y%m%dT%H%M%SZ)"
fi

case "$URL" in
  http://* | https://*) ;;
  *) echo "URL must use http:// or https://" >&2; exit 2 ;;
esac

umask 077
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/shipwright-webhook-replay.XXXXXX")"
PAYLOAD_SNAPSHOT="$TEMP_DIR/payload.json"
RESPONSE_FILE="$TEMP_DIR/response.json"
cleanup() {
  rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT HUP INT TERM
cp -- "$PAYLOAD_FILE" "$PAYLOAD_SNAPSHOT"

SIG_HEX="$(python3 - "$PAYLOAD_SNAPSHOT" 3< <(printf '%s' "$WEBHOOK_SECRET") <<'PY'
import hashlib
import hmac
import os
import sys

with os.fdopen(3, "rb") as secret, open(sys.argv[1], "rb") as payload:
    print(hmac.new(secret.read(), payload.read(), hashlib.sha256).hexdigest())
PY
)"
SIGNATURE="sha256=${SIG_HEX}"
unset WEBHOOK_SECRET

post_once() {
  local id="$1"
  curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
    -X POST \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: $EVENT" \
    -H "X-GitHub-Delivery: $id" \
    -H "X-Hub-Signature-256: $SIGNATURE" \
    --data-binary "@$PAYLOAD_SNAPSHOT" \
    -- "$URL"
}

print_response_summary() {
  python3 - "$RESPONSE_FILE" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as response:
        payload = json.load(response)
except (OSError, UnicodeError, json.JSONDecodeError):
    print('{"response":"unavailable"}')
    raise SystemExit

summary = {}
status = payload.get("status") if isinstance(payload, dict) else None
if status in {"accepted", "rejected"}:
    summary["status"] = status
reason = payload.get("reason") if isinstance(payload, dict) else None
if reason in {"invalid_signature", "invalid_payload"}:
    summary["reason"] = reason
for key in ("matched", "conditionFiltered", "decisionsTruncated"):
    value = payload.get(key) if isinstance(payload, dict) else None
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        summary[key] = value
decisions = payload.get("decisions") if isinstance(payload, dict) else None
if isinstance(decisions, list):
    summary["decisionCount"] = len(decisions)
print(json.dumps(summary or {"response": "unavailable"}, separators=(",", ":")))
PY
}

echo "POST $URL event=$EVENT delivery=$DELIVERY_ID payload=$PAYLOAD_FILE"
CODE="$(post_once "$DELIVERY_ID")"
echo "HTTP $CODE"
print_response_summary

if [[ "$REPLAY" == true ]]; then
  echo "--- replay same X-GitHub-Delivery ---"
  CODE2="$(post_once "$DELIVERY_ID")"
  echo "HTTP $CODE2"
  print_response_summary
  echo "Expect: both 202; operator history / queue shows one execution for this delivery+revision."
fi
