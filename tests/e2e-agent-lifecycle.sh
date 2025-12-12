#!/usr/bin/env bash
set -euo pipefail

# End-to-end smoke for the baked cdx lifecycle:
# 1) Register a host via admin API
# 2) Download the single-use installer and assert it is baked
# 3) Fetch wrapper metadata and download the baked cdx
# 4) Hit /auth (retrieve) to ensure the key works
# 5) Deregister the host
#
# Intended for local/dev stacks. This will create and delete a host record.

BASE_URL="${BASE_URL:-http://localhost:8488}"
ADMIN_KEY="${ADMIN_KEY:-${DASHBOARD_ADMIN_KEY:-}}"
CA_FILE="${CA_FILE:-}"
HOST_HEADER="${HOST_HEADER:-}"
KEEP_HOST="${KEEP_HOST:-0}"
FORCE_DELETE="${FORCE_DELETE:-1}"
TMP_ROOT="$(mktemp -d)"

log() { printf '== %s\n' "$*"; }
fail() { printf '!! %s\n' "$*" >&2; exit 1; }

require_cmd() {
  local missing=()
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  if (( ${#missing[@]} )); then
    fail "Missing commands: ${missing[*]}"
  fi
}

require_cmd curl jq sha256sum

BASE_URL="${BASE_URL%/}"
[[ "$BASE_URL" =~ ^https?:// ]] || fail "BASE_URL must include scheme (got: $BASE_URL)"

curl_base_args=(
  -sS
  -H "X-mTLS-Present: 1"
)
[[ -n "$CA_FILE" ]] && curl_base_args+=(--cacert "$CA_FILE")
[[ -n "$HOST_HEADER" ]] && curl_base_args+=(-H "Host: $HOST_HEADER")
if [[ -n "$ADMIN_KEY" ]]; then
  curl_base_args+=(-H "X-Admin-Key: $ADMIN_KEY")
fi

api_call() {
  local method="$1"; shift
  local url="$1"; shift
  curl "${curl_base_args[@]}" -X "$method" "$url" "$@"
}

api_json() {
  local method="$1"; shift
  local url="$1"; shift
  local body="${1-}"
  shift || true
  local extra=("$@")
  if [[ -n "$body" ]]; then
    extra=(-H "Content-Type: application/json" -d "$body" "${extra[@]}")
  fi
  api_call "$method" "$url" "${extra[@]}"
}

cleanup() {
  if (( KEEP_HOST )); then
    log "Keeping host id=$HOST_ID (KEEP_HOST=1)"
    return
  fi
  if [[ -n "${HOST_ID-}" ]]; then
    log "Deleting host id=$HOST_ID"
    api_call DELETE "${BASE_URL}/admin/hosts/${HOST_ID}" >/dev/null 2>&1 || true
  fi
}

teardown() {
  cleanup
  rm -rf "$TMP_ROOT"
}

trap teardown EXIT

HOST_FQDN="e2e-$(date +%Y%m%d%H%M%S)-$RANDOM"
log "Registering host $HOST_FQDN"
register_resp="$TMP_ROOT/register.json"
api_json POST "${BASE_URL}/admin/hosts/register" "{\"fqdn\":\"${HOST_FQDN}\"}" >"$register_resp" || fail "register request failed"
HOST_ID="$(jq -r '.data.host.id // empty' <"$register_resp")"
API_KEY="$(jq -r '.data.host.api_key // empty' <"$register_resp")"
INSTALL_URL="$(jq -r '.data.installer.url // empty' <"$register_resp")"
INSTALL_TOKEN="$(jq -r '.data.installer.token // empty' <"$register_resp")"
[[ -n "$HOST_ID" && -n "$API_KEY" && -n "$INSTALL_URL" && -n "$INSTALL_TOKEN" ]] || fail "register response missing fields: $(cat "$register_resp")"
log "Host id=$HOST_ID api_key=${API_KEY:0:8}… token=${INSTALL_TOKEN}"

log "Downloading installer (one-time)"
installer_path="$TMP_ROOT/installer.sh"
installer_headers="$TMP_ROOT/installer.hdr"
curl "${curl_base_args[@]}" -D "$installer_headers" -o "$installer_path" -sS "$INSTALL_URL" || fail "installer download failed"
inst_status=$(awk 'NR==1 {print $2}' "$installer_headers")
[[ "$inst_status" == "200" ]] || fail "installer expected 200, got ${inst_status:-unknown}"
grep -Eq "curl(_fetch)? -fsSL \\\"$BASE_URL/wrapper/download\\\"" "$installer_path" || fail "installer missing wrapper download URL"
grep -q "X-API-Key: ${API_KEY}" "$installer_path" || fail "installer missing API key"
grep -q "Installing Codex for ${HOST_FQDN} via ${BASE_URL}" "$installer_path" || fail "installer missing fqdn/base line"
second_status=$(curl "${curl_base_args[@]}" -s -o /dev/null -w '%{http_code}' "$INSTALL_URL")
[[ "$second_status" == "410" ]] || fail "installer token reuse should 410, got $second_status"

log "Fetching wrapper metadata"
wrapper_meta="$TMP_ROOT/wrapper.json"
api_call GET "${BASE_URL}/wrapper" -H "X-API-Key: ${API_KEY}" >"$wrapper_meta" || fail "wrapper metadata fetch failed"
WRAP_VERSION="$(jq -r '.data.version // empty' <"$wrapper_meta")"
WRAP_SHA="$(jq -r '.data.sha256 // empty' <"$wrapper_meta")"
[[ -n "$WRAP_VERSION" ]] || fail "wrapper version missing: $(cat "$wrapper_meta")"

log "Downloading baked cdx"
cdx_path="$TMP_ROOT/cdx"
cdx_headers="$TMP_ROOT/cdx.hdr"
curl "${curl_base_args[@]}" -D "$cdx_headers" -o "$cdx_path" -sS "${BASE_URL}/wrapper/download" -H "X-API-Key: ${API_KEY}" || fail "wrapper download failed"
cdx_status=$(awk 'NR==1 {print $2}' "$cdx_headers")
[[ "$cdx_status" == "200" ]] || fail "wrapper download expected 200, got ${cdx_status:-unknown}"
download_sha="$(sha256sum "$cdx_path" | awk '{print $1}')"
[[ "$download_sha" == "$WRAP_SHA" ]] || fail "wrapper sha mismatch: header=$WRAP_SHA actual=$download_sha"
grep -Eq "CODEX_SYNC_BASE_URL_DEFAULT=.*${BASE_URL}" "$cdx_path" || fail "cdx not baked with base URL"
grep -Eq "CODEX_SYNC_API_KEY.*${API_KEY}" "$cdx_path" || fail "cdx not baked with API key"
grep -Eq "CODEX_SYNC_FQDN.*${HOST_FQDN}" "$cdx_path" || fail "cdx not baked with fqdn"
grep -Eq "WRAPPER_VERSION=.*${WRAP_VERSION}" "$cdx_path" || fail "cdx wrapper version missing"

log "Calling /auth (retrieve) to validate API key works"
auth_body=$(cat <<JSON
{
  "command": "retrieve",
  "digest": "$(printf '0%.0s' {1..64})",
  "last_refresh": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "client_version": "e2e-test",
  "wrapper_version": "${WRAP_VERSION}"
}
JSON
)
auth_resp="$TMP_ROOT/auth.json"
api_json POST "${BASE_URL}/auth" "$auth_body" -H "X-API-Key: ${API_KEY}" >"$auth_resp" || fail "/auth retrieve failed"
AUTH_STATUS="$(jq -r '.data.status // empty' <"$auth_resp")"
[[ -n "$AUTH_STATUS" ]] || fail "/auth response missing status: $(cat "$auth_resp")"
log "/auth status=${AUTH_STATUS}"

if (( FORCE_DELETE )) && [[ -n "${API_KEY-}" ]]; then
  api_call DELETE "${BASE_URL}/auth?force=1" -H "X-API-Key: ${API_KEY}" >/dev/null 2>&1 || true
fi

log "Lifecycle smoke completed for ${HOST_FQDN}"
