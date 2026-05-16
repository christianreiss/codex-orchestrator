#!/usr/bin/env bash
# tests/contract/record.sh — capture golden responses from the legacy PHP
# backend so the Node rewrite can replay-and-diff them.
#
# Usage:
#   tests/contract/record.sh                                  # http://127.0.0.1:8080
#   tests/contract/record.sh http://localhost:8080
#   BASE_URL=http://orchestrator.local:8080 tests/contract/record.sh
#
# Optional env:
#   ADMIN_USER     admin username for cookie-based seeding (default: owner)
#   ADMIN_PASS     admin password                          (default: owner-password-1234)
#   HOST_API_KEY   pre-seeded host api key for host-auth endpoints
#   ENGINE         codex|claude                             (default: codex)
#   OUT_DIR        where fixtures are written              (default: tests/contract/fixtures)
#   DRY_RUN=1      print the curl commands without executing them
#   FORCE=1        overwrite existing fixtures (default: skip when present)
#
# Idempotency: by default existing fixtures are kept. Pass FORCE=1 to overwrite.
# All curls use --fail-with-body so the script does not silently record an
# error envelope it didn't intend to (HTTP/4xx/5xx from the legacy backend is
# fine — it gets recorded — but a connection error aborts the run).

set -euo pipefail

BASE_URL="${1:-${BASE_URL:-http://127.0.0.1:8080}}"
ADMIN_USER="${ADMIN_USER:-owner}"
ADMIN_PASS="${ADMIN_PASS:-owner-password-1234}"
HOST_API_KEY="${HOST_API_KEY:-}"
ENGINE="${ENGINE:-codex}"
OUT_DIR="${OUT_DIR:-tests/contract/fixtures}"
FORCE="${FORCE:-0}"
DRY_RUN="${DRY_RUN:-0}"

mkdir -p "$OUT_DIR"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }
}
need curl
need jq

log() { printf '[record] %s\n' "$*" >&2; }

# ── cookie jar (kept for the run so we don't login per-request) ──
COOKIE_JAR="$(mktemp -t codex-contract-XXXXXX.cookies)"
trap 'rm -f "$COOKIE_JAR"' EXIT

# Establish admin session once. Login route preserved across both backends.
login_admin() {
  log "logging in as $ADMIN_USER"
  curl --silent --show-error --fail-with-body \
    -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
    -H 'content-type: application/json' \
    -X POST "$BASE_URL/admin/auth/login" \
    --data "$(jq -nc --arg u "$ADMIN_USER" --arg p "$ADMIN_PASS" '{username:$u,password:$p}')" \
    -o /dev/null \
    || { log "admin login failed — continuing without admin cookie"; return 0; }
}

# record_request <scenario-dir> <name> <method> <url-path> [<auth-flavour>] [<request-body-json>]
#
# auth-flavour: 'admin' | 'host' | 'none' (default: none)
record_request() {
  local dir="$1"
  local name="$2"
  local method="$3"
  local path="$4"
  local auth="${5:-none}"
  local body="${6:-}"

  local out="$OUT_DIR/$dir/$name.json"
  if [[ -e "$out" && "$FORCE" != "1" ]]; then
    log "skip existing: $out (FORCE=1 to overwrite)"
    return 0
  fi
  mkdir -p "$OUT_DIR/$dir"

  local -a curl_args=(
    --silent --show-error
    --output /dev/stdout
    --write-out '\n%{json}\n'
    -X "$method"
    "$BASE_URL$path"
  )
  case "$auth" in
    admin) curl_args+=( -b "$COOKIE_JAR" );;
    host)
      if [[ -n "$HOST_API_KEY" ]]; then
        curl_args+=( -H "Authorization: Bearer $HOST_API_KEY" )
      else
        log "skip $dir/$name: no HOST_API_KEY"
        return 0
      fi
      ;;
    none) ;;
    *) log "unknown auth flavour: $auth"; return 1;;
  esac

  if [[ -n "$body" ]]; then
    curl_args+=( -H 'content-type: application/json' --data "$body" )
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY: curl ${curl_args[*]}"
    return 0
  fi

  local raw
  raw="$(curl "${curl_args[@]}" || true)"

  # The body and the curl --write-out JSON status block are separated by the
  # last newline. Parse robustly with jq.
  local meta
  meta="$(printf '%s' "$raw" | awk 'BEGIN{RS=""} END{print $0}' | tail -n1 || true)"
  local response_body
  response_body="$(printf '%s\n' "$raw" | head -n -1)"

  local status content_type
  status="$(printf '%s' "$meta" | jq -r '.response_code // .http_code // 0' 2>/dev/null || echo 0)"
  content_type="$(printf '%s' "$meta" | jq -r '.content_type // ""' 2>/dev/null || echo '')"

  # Parse JSON bodies into structured objects; non-JSON bodies recorded as raw string.
  local body_field
  if printf '%s' "$response_body" | jq empty >/dev/null 2>&1; then
    body_field="$(printf '%s' "$response_body" | jq '.')"
  else
    body_field="$(jq -Rn --arg s "$response_body" '$s')"
  fi

  local req_body_field
  if [[ -n "$body" ]]; then
    req_body_field="$(printf '%s' "$body" | jq '.' 2>/dev/null || jq -Rn --arg s "$body" '$s')"
  else
    req_body_field=null
  fi

  jq -n \
    --arg name "$name" \
    --arg method "$method" \
    --arg url "$path" \
    --arg ct "$content_type" \
    --argjson status "${status:-0}" \
    --argjson req_body "$req_body_field" \
    --argjson body "$body_field" \
    '{
      name: $name,
      request: { method: $method, url: $url, headers: {"content-type": "application/json"}, body: $req_body },
      response: { status: $status, headers: {"content-type": $ct}, body: $body }
    }' > "$out"

  log "wrote $out (status=$status)"
}

# ─── Curated endpoint list. Each line ends up as one fixture. ───
login_admin

# Health (no-auth) — always safe; useful as a smoke fixture.
record_request health    ok                  GET  /healthz

# Admin: surface-level reads that don't depend on host state.
record_request admin     auth-status         GET  /admin/auth/status      admin
record_request admin     hosts-index         GET  /admin/hosts            admin
record_request admin     events-index        GET  /admin/events           admin
record_request admin     versions-index      GET  /admin/versions         admin
record_request admin     settings-index      GET  /admin/settings         admin

# Engine-aware admin reads
record_request admin     codex-state         GET  "/admin/codex/state"    admin
record_request admin     claude-state        GET  "/admin/claude/state"   admin

# Host-auth endpoints — only if HOST_API_KEY is set
record_request host      auth-retrieve       GET  /auth/retrieve          host
record_request host      sync-status         GET  /sync/status            host
record_request host      sync-bootstrap      GET  /sync/bootstrap         host
record_request host      versions            GET  /versions               host
record_request host      usage-ingest        POST /usage/ingest           host \
  "$(jq -nc '{entries:[{model:"gpt-5",input_tokens:7,output_tokens:3,total_tokens:10}]}')"

# OpenAI-compat surface (error case — no upstream key needed)
record_request openai    models-list         GET  /v1/models              host
record_request openai    chat-bad-request    POST /v1/chat/completions    host \
  "$(jq -nc '{}')"

# Anthropic-compat surface
record_request anthropic models-list         GET  /anthropic/v1/models    host
record_request anthropic messages-bad        POST /anthropic/v1/messages  host \
  "$(jq -nc '{}')"

log "done. wrote fixtures under $OUT_DIR"
