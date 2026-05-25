#!/usr/bin/env bash
# Regression test for the /api/router/* surface added in PR #57.
#
# Usage:
#   scripts/test-router.sh                        # defaults to http://127.0.0.1:8080
#   scripts/test-router.sh http://35.168.148.47   # against live nginx
#   ROUTER_TOKEN=xyz scripts/test-router.sh ...   # send Bearer token
#   SKIP_VIDEO=1 scripts/test-router.sh ...       # skip the ~2-min Seedance test
#
# Exits non-zero on any failure. Each test prints PASS / FAIL with a short
# reason and (on failure) the raw response.

set -uo pipefail

BASE="${1:-http://127.0.0.1:8080}"
BASE="${BASE%/}"
ROUTE="${BASE}/api/router"

PASS=0
FAIL=0
FAILED_NAMES=()

# ─── tiny test harness ────────────────────────────────────────────────

auth_header_args=()
if [ -n "${ROUTER_TOKEN:-}" ]; then
  auth_header_args=(-H "Authorization: Bearer ${ROUTER_TOKEN}")
fi

# call_router METHOD PATH [CURL_ARGS...]  → echoes raw response
call_router() {
  local method="$1"; shift
  local path="$1"; shift
  curl -sS -X "$method" "${auth_header_args[@]}" "${ROUTE}${path}" "$@"
}

# assert NAME EXPECTED_SUBSTRING ACTUAL_RESPONSE
assert_contains() {
  local name="$1" expected="$2" actual="$3"
  if printf '%s' "$actual" | grep -qF "$expected"; then
    printf '\033[32mPASS\033[0m  %s\n' "$name"
    PASS=$((PASS+1))
  else
    printf '\033[31mFAIL\033[0m  %s\n' "$name"
    printf '  expected substring: %s\n' "$expected"
    printf '  got: %s\n' "${actual:0:300}"
    FAIL=$((FAIL+1))
    FAILED_NAMES+=("$name")
  fi
}

# assert_http NAME EXPECTED_CODE METHOD PATH [CURL_ARGS...]
assert_http() {
  local name="$1" expected_code="$2" method="$3" path="$4"; shift 4
  local actual_code
  actual_code=$(curl -sS -o /dev/null -w "%{http_code}" -X "$method" "${auth_header_args[@]}" "${ROUTE}${path}" "$@")
  if [ "$actual_code" = "$expected_code" ]; then
    printf '\033[32mPASS\033[0m  %s (HTTP %s)\n' "$name" "$actual_code"
    PASS=$((PASS+1))
  else
    printf '\033[31mFAIL\033[0m  %s (expected HTTP %s, got %s)\n' "$name" "$expected_code" "$actual_code"
    FAIL=$((FAIL+1))
    FAILED_NAMES+=("$name")
  fi
}

printf '\n== Router regression suite ==\nTarget: %s\n\n' "$ROUTE"

# ─── 1. /models — catalog read ────────────────────────────────────────

RESP=$(call_router GET /models)
assert_contains "GET /models returns catalog" '"models"' "$RESP"
assert_contains "GET /models includes seedance entry" 'seedance' "$RESP"

# ─── 2. /test-key — credential test ──────────────────────────────────

# Pull real key from env so the test works locally and on the host (which
# both share the same .env layout). If unset we still want to assert the
# empty-key + bad-key branches.
if [ -f "$(dirname "$0")/../.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$(dirname "$0")/../.env"; set +a
fi
REAL_BYTEDANCE_KEY="${BYTEPLUS_ARK_API_KEY:-${ARK_API_KEY:-}}"

RESP=$(call_router POST /test-key -H 'Content-Type: application/json' -d '{"provider":"bytedance","key":""}')
assert_contains "/test-key empty → ok:false" '"ok":false' "$RESP"

RESP=$(call_router POST /test-key -H 'Content-Type: application/json' -d '{"provider":"bytedance","key":"sk-deadbeef-not-a-real-key"}')
assert_contains "/test-key bad key → Invalid" 'Invalid API key' "$RESP"

if [ -n "$REAL_BYTEDANCE_KEY" ]; then
  RESP=$(call_router POST /test-key -H 'Content-Type: application/json' \
    -d "{\"provider\":\"bytedance\",\"key\":\"$REAL_BYTEDANCE_KEY\"}")
  assert_contains "/test-key real key → Connected" 'Connected' "$RESP"
else
  printf '\033[33mSKIP\033[0m  /test-key real key (BYTEPLUS_ARK_API_KEY not set in env)\n'
fi

# ─── 3. /assets — upload roundtrip ───────────────────────────────────

# 1×1 transparent PNG as a data URL
PNG_DATA='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

RESP=$(call_router POST /assets -H 'Content-Type: application/json' \
  -d "{\"dataUrl\":\"$PNG_DATA\"}")
assert_contains "/assets dataUrl → assetId returned" '"assetId"' "$RESP"
assert_contains "/assets dataUrl → /uploads/ url" '"/uploads/' "$RESP"

# Extract URL and verify it's actually downloadable through the same server.
HOSTED_URL=$(printf '%s' "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("url",""))' 2>/dev/null || true)
if [ -n "$HOSTED_URL" ]; then
  TMPFILE=$(mktemp /tmp/router-test-asset.XXXXXX.png)
  curl -sS -o "$TMPFILE" "${BASE}${HOSTED_URL}"
  if file "$TMPFILE" | grep -q "PNG image data"; then
    printf '\033[32mPASS\033[0m  /assets uploaded file is downloadable (%s)\n' "$HOSTED_URL"
    PASS=$((PASS+1))
  else
    printf '\033[31mFAIL\033[0m  /assets file did not download as PNG\n'
    file "$TMPFILE"
    FAIL=$((FAIL+1))
    FAILED_NAMES+=("/assets download")
  fi
  rm -f "$TMPFILE"
fi

# Raw body shape
RESP=$(printf 'router-test-raw-bytes' | curl -sS -X POST "${auth_header_args[@]}" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @- "${ROUTE}/assets?contentType=text/plain")
assert_contains "/assets raw bytes → assetId returned" '"assetId"' "$RESP"

# ─── 4. /run error paths ──────────────────────────────────────────────

RESP=$(call_router POST /run -H 'Content-Type: application/json' -d '{}')
assert_contains "/run missing capability → 400 error" 'capability is required' "$RESP"

RESP=$(call_router POST /run -H 'Content-Type: application/json' -d '{"capability":"nonsense"}')
assert_contains "/run bad capability → no default provider" 'no default provider' "$RESP"

RESP=$(call_router POST /run -H 'Content-Type: application/json' --data-binary 'not json')
assert_contains "/run bad json → parse error" 'bad json' "$RESP"

assert_http "GET unknown route → 404" 404 GET /does-not-exist

# ─── 5. /tasks — registry ─────────────────────────────────────────────

assert_http "GET /tasks/unknown → 404" 404 GET /tasks/tr_does_not_exist

# ─── 6. Per-provider sync image smoke tests ──────────────────────────
#
# Each smoke test issues a real text-to-image call against the provider.
# Upstream credential / account / project issues (key missing scope, model
# not activated, API not enabled) get reclassified from FAIL to SKIP with
# the provider's own error message — those aren't router bugs and a clean
# regression run on a misconfigured host shouldn't mask the real failures.

UPSTREAM_PATTERNS='not activated|ModelNotOpen|AccessDenied|InvalidEndpointOrModel|do not have access|has not been used|API_KEY|not authorized|missing_permissions|insufficient_quota'

smoke_sync_image() {
  local name="$1" model="$2" extra_params="$3"
  printf 'Smoke: %s … ' "$name"
  local body
  body="{\"capability\":\"text-to-image\",\"model\":\"$model\",\"prompt\":\"a single red cube on a white background, studio lighting\",\"params\":${extra_params}}"
  local resp
  resp=$(curl -sS --max-time 90 -X POST "${auth_header_args[@]}" -H 'Content-Type: application/json' -d "$body" "${ROUTE}/run")
  if printf '%s' "$resp" | grep -q '"outputs"'; then
    printf '\033[32mPASS\033[0m\n'
    PASS=$((PASS+1))
  elif printf '%s' "$resp" | grep -qE "$UPSTREAM_PATTERNS"; then
    local reason
    reason=$(printf '%s' "$resp" | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("error","")[:80]))' 2>/dev/null || true)
    printf '\033[33mSKIP\033[0m (upstream creds: %s)\n' "$reason"
  else
    printf '\033[31mFAIL\033[0m\n  body: %s\n' "${resp:0:300}"
    FAIL=$((FAIL+1))
    FAILED_NAMES+=("$name")
  fi
}

smoke_sync_image 'OpenAI gpt-image-2'    'gpt-image-2'    '{"aspectRatio":"1:1","imageSize":"1K","quality":"low"}'
smoke_sync_image 'Gemini nano-banana-2'  'nano-banana-2'  '{"aspectRatio":"1:1","imageSize":"1K"}'
smoke_sync_image 'xAI grok-imagine'      'grok-imagine'   '{"aspectRatio":"1:1","quality":"normal"}'
smoke_sync_image 'Luma uni-1'            'luma-uni-1'     '{"aspectRatio":"16:9"}'
smoke_sync_image 'Seedream 5.0'          'seedream-5.0'   '{"aspectRatio":"1:1","resolution":"1K"}'

# ─── 7. fal video submit (dispatch verification, no completion wait) ──

printf 'Smoke: fal grok-video (submit only, no await) … '
RESP=$(curl -sS --max-time 30 -X POST "${auth_header_args[@]}" -H 'Content-Type: application/json' \
  -d '{"capability":"text-to-video","model":"grok-video","prompt":"red cube spinning","params":{"duration":"5","aspect_ratio":"16:9"}}' \
  "${ROUTE}/run")
if printf '%s' "$RESP" | grep -q '"taskId"'; then
  TID=$(printf '%s' "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("taskId",""))' 2>/dev/null || true)
  printf '\033[32mPASS\033[0m  (taskId=%s)\n' "$TID"
  PASS=$((PASS+1))
elif printf '%s' "$RESP" | grep -qE "$UPSTREAM_PATTERNS"; then
  printf '\033[33mSKIP\033[0m (upstream)\n'
else
  printf '\033[31mFAIL\033[0m\n  body: %s\n' "${RESP:0:300}"
  FAIL=$((FAIL+1))
  FAILED_NAMES+=("fal submit")
fi

printf 'Smoke: fal kling-3.0 (submit only, no await) … '
RESP=$(curl -sS --max-time 30 -X POST "${auth_header_args[@]}" -H 'Content-Type: application/json' \
  -d '{"capability":"text-to-video","model":"kling-3.0","prompt":"red cube spinning","params":{"duration":"5","aspectRatio":"16:9"}}' \
  "${ROUTE}/run")
if printf '%s' "$RESP" | grep -q '"taskId"'; then
  printf '\033[32mPASS\033[0m\n'
  PASS=$((PASS+1))
elif printf '%s' "$RESP" | grep -qE "$UPSTREAM_PATTERNS"; then
  printf '\033[33mSKIP\033[0m (upstream)\n'
else
  printf '\033[31mFAIL\033[0m\n  body: %s\n' "${RESP:0:300}"
  FAIL=$((FAIL+1))
  FAILED_NAMES+=("kling-3.0 submit")
fi

# ─── 8. /run text-to-video (Seedance, full async + long-poll) ────────

if [ "${SKIP_VIDEO:-0}" = "1" ]; then
  printf '\033[33mSKIP\033[0m  Seedance video test (SKIP_VIDEO=1)\n'
else
  printf 'Submitting Seedance text-to-video task… (takes 60-180s)\n'
  RESP=$(call_router POST /run -H 'Content-Type: application/json' -d '{
    "capability": "text-to-video",
    "model": "seedance-2.0-fast",
    "prompt": "A serene mountain lake at dawn, gentle mist, soft golden light",
    "params": {"duration": "5", "ratio": "16:9", "resolution": "480p", "generate_audio": "false"}
  }')
  TASKID=$(printf '%s' "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("taskId",""))' 2>/dev/null || true)

  if [ -z "$TASKID" ]; then
    printf '\033[31mFAIL\033[0m  Seedance submit returned no taskId\n  body: %s\n' "${RESP:0:300}"
    FAIL=$((FAIL+1))
    FAILED_NAMES+=("Seedance submit")
  else
    printf '\033[32mPASS\033[0m  /run text-to-video → taskId=%s\n' "$TASKID"
    PASS=$((PASS+1))

    # Long-poll up to ~3 min (9 rounds × 20s).
    FINAL_STATUS=""
    FINAL_URL=""
    for round in 1 2 3 4 5 6 7 8 9; do
      RESP=$(curl -sS "${auth_header_args[@]}" "${ROUTE}/tasks/${TASKID}?wait=20")
      FINAL_STATUS=$(printf '%s' "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)
      printf '  round %d: status=%s\n' "$round" "$FINAL_STATUS"
      if [ "$FINAL_STATUS" = "done" ] || [ "$FINAL_STATUS" = "failed" ]; then
        FINAL_URL=$(printf '%s' "$RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); o=d.get("outputs",[{}])[0]; print(o.get("url",""))' 2>/dev/null || true)
        break
      fi
    done

    if [ "$FINAL_STATUS" = "done" ] && [ -n "$FINAL_URL" ]; then
      printf '\033[32mPASS\033[0m  Seedance task completed, output=%s\n' "$FINAL_URL"
      PASS=$((PASS+1))
      TMP_VID=$(mktemp /tmp/router-test-vid.XXXXXX.mp4)
      curl -sS -o "$TMP_VID" "${BASE}${FINAL_URL}"
      if file "$TMP_VID" | grep -qi "iso media\|mp4"; then
        SIZE=$(stat -c '%s' "$TMP_VID" 2>/dev/null || stat -f '%z' "$TMP_VID")
        printf '\033[32mPASS\033[0m  Seedance video downloads + is valid MP4 (%s bytes)\n' "$SIZE"
        PASS=$((PASS+1))
      else
        printf '\033[31mFAIL\033[0m  Seedance video did not download as MP4\n'
        file "$TMP_VID"
        FAIL=$((FAIL+1))
        FAILED_NAMES+=("Seedance download")
      fi
      rm -f "$TMP_VID"
    else
      printf '\033[31mFAIL\033[0m  Seedance never completed (final status=%s)\n' "$FINAL_STATUS"
      FAIL=$((FAIL+1))
      FAILED_NAMES+=("Seedance completion")
    fi
  fi
fi

# ─── summary ──────────────────────────────────────────────────────────

printf '\n== Summary ==\n'
printf '  passed: %d\n' "$PASS"
printf '  failed: %d\n' "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '  failures:\n'
  for name in "${FAILED_NAMES[@]}"; do
    printf '    - %s\n' "$name"
  done
  exit 1
fi
exit 0
