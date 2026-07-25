#!/usr/bin/env bash
# Replay a signed GitHub webhook delivery against a running Shipwright instance.
# Signing matches ui/server/routes/api/github/webhook.post.spec.ts (HMAC-SHA256, sha256= prefix).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: replay-github-webhook.sh [options]

Required:
  GITHUB_WEBHOOK_SECRET   Same value as on the pin and in the GitHub App webhook settings.

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

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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

if [[ -z "${GITHUB_WEBHOOK_SECRET:-}" ]]; then
  echo "GITHUB_WEBHOOK_SECRET is required" >&2
  exit 2
fi

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

if [[ -z "$DELIVERY_ID" ]]; then
  DELIVERY_ID="u1-proof-$(date -u +%Y%m%dT%H%M%SZ)"
fi

BODY="$(cat "$PAYLOAD_FILE")"
SIG_HEX="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | awk '{print $NF}')"
SIGNATURE="sha256=${SIG_HEX}"

post_once() {
  local id="$1"
  curl -sS -o /tmp/shipwright-webhook-replay-body.txt -w '%{http_code}' \
    -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "X-GitHub-Event: $EVENT" \
    -H "X-GitHub-Delivery: $id" \
    -H "X-Hub-Signature-256: $SIGNATURE" \
    --data-binary "$BODY"
}

echo "POST $URL event=$EVENT delivery=$DELIVERY_ID payload=$PAYLOAD_FILE"
CODE="$(post_once "$DELIVERY_ID")"
echo "HTTP $CODE"
head -c 2000 /tmp/shipwright-webhook-replay-body.txt; echo

if [[ "$REPLAY" == true ]]; then
  echo "--- replay same X-GitHub-Delivery ---"
  CODE2="$(post_once "$DELIVERY_ID")"
  echo "HTTP $CODE2"
  head -c 2000 /tmp/shipwright-webhook-replay-body.txt; echo
  echo "Expect: both 202; operator history / queue shows one execution for this delivery+revision."
fi
