#!/usr/bin/env bash
# Issue, check or repair the bundled Caddy's self-signed TLS material.
#
#   selfsigned-tls.sh issue DIR CN [SANS]   create or repair; idempotent
#   selfsigned-tls.sh check DIR             exit 0 when CA + leaf pass strict checks
#
# DIR holds ca.key, ca.crt, server.key and server.crt. SANS is a comma list;
# entries made of digits and dots become IP SANs, everything else DNS, and CN is
# always added as a DNS SAN.
#
# Why this exists: `openssl req -x509` with the stock openssl.cnf writes a CA
# with basicConstraints but no keyUsage. OpenSSL's X509_STRICT mode — the
# default in Python 3.13+ `ssl.create_default_context()` — rejects such an
# anchor ("CA cert does not include key usage extension"), while curl and Go
# accept it, so the defect only surfaces in strict clients.
#
# Repair never throws away trust. An existing ca.key is always reused: a
# non-compliant ca.crt is re-signed from the same key with the same subject, so
# its Subject Key Identifier is unchanged and every leaf the key ever signed
# still verifies against both the old and the new ca.crt. Clients that keep the
# old ca.crt keep working exactly as before; clients given the new one also pass
# strict verification. The previous ca.crt is kept as ca.crt.legacy-<UTC stamp>.
# To mint an entirely new CA key, move ca.key away first — that does break trust
# on every client and is never done implicitly.
set -euo pipefail

CA_DAYS=3650
LEAF_DAYS=825
# Reissue a leaf that expires within 30 days.
LEAF_RENEW_SECONDS=$((30 * 24 * 3600))

log() { printf '[selfsigned-tls] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

ext_text() { openssl x509 -in "$1" -noout -text 2>/dev/null; }

# Structural checks are explicit because `openssl verify -x509_strict` on
# OpenSSL < 3.x does not insist on a CA keyUsage; the verify call below adds the
# chain and signature check on top.
ca_compliant() {
  local crt="$1" text
  [[ -s "$crt" ]] || return 1
  text="$(ext_text "$crt")" || return 1
  grep -q 'X509v3 Basic Constraints: critical' <<<"$text" || return 1
  grep -q 'CA:TRUE' <<<"$text" || return 1
  grep -q 'X509v3 Key Usage: critical' <<<"$text" || return 1
  grep -q 'Certificate Sign' <<<"$text" || return 1
  grep -q 'CRL Sign' <<<"$text" || return 1
  grep -q 'X509v3 Subject Key Identifier' <<<"$text" || return 1
}

leaf_compliant() {
  local dir="$1" text
  [[ -s "$dir/server.crt" && -s "$dir/server.key" ]] || return 1
  text="$(ext_text "$dir/server.crt")" || return 1
  grep -q 'X509v3 Authority Key Identifier' <<<"$text" || return 1
  grep -q 'X509v3 Key Usage: critical' <<<"$text" || return 1
  grep -q 'Digital Signature' <<<"$text" || return 1
  grep -q 'TLS Web Server Authentication' <<<"$text" || return 1
  grep -q 'X509v3 Subject Alternative Name' <<<"$text" || return 1
  openssl x509 -in "$dir/server.crt" -noout -checkend "$LEAF_RENEW_SECONDS" >/dev/null 2>&1 || return 1
  openssl verify -x509_strict -CAfile "$dir/ca.crt" "$dir/server.crt" >/dev/null 2>&1 || return 1
  # The key on disk must still match the certificate Caddy will serve.
  [[ "$(openssl x509 -in "$dir/server.crt" -noout -pubkey)" == "$(openssl pkey -in "$dir/server.key" -pubout)" ]]
}

write_ca_ext() {
  cat > "$1" <<'EOF'
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF
}

issue_ca() {
  local dir="$1" cn="$2" ext stamp
  ext="$(mktemp "$dir/.ca-ext.XXXXXX")"
  write_ca_ext "$ext"
  if [[ -s "$dir/ca.key" ]]; then
    if [[ -s "$dir/ca.crt" ]]; then
      # Re-sign the existing certificate itself: subject, key and therefore
      # SKI stay identical, so chain building and leaf signatures are
      # unchanged. Old extensions are dropped and replaced; a fresh serial
      # keeps issuer+serial unique.
      stamp="$(date -u +%Y%m%dT%H%M%SZ)"
      cp -p "$dir/ca.crt" "$dir/ca.crt.legacy-$stamp"
      log "re-signing ca.crt from the existing ca.key (previous kept as ca.crt.legacy-$stamp)"
      openssl x509 -in "$dir/ca.crt" -signkey "$dir/ca.key" -days "$CA_DAYS" -sha256 \
        -set_serial "0x$(openssl rand -hex 16)" -clrext -extfile "$ext" -extensions v3_ca \
        -out "$dir/ca.crt.new" >/dev/null 2>&1
    else
      log "issuing ca.crt from the existing ca.key"
      openssl req -x509 -new -sha256 -days "$CA_DAYS" -key "$dir/ca.key" \
        -subj "/CN=${cn} Local CA" -config "$ext" -extensions v3_ca \
        -out "$dir/ca.crt.new" >/dev/null 2>&1
    fi
  else
    log "generating a new local CA"
    ( umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$dir/ca.key" >/dev/null 2>&1 )
    openssl req -x509 -new -sha256 -days "$CA_DAYS" -key "$dir/ca.key" \
      -subj "/CN=${cn} Local CA" -config "$ext" -extensions v3_ca \
      -out "$dir/ca.crt.new" >/dev/null 2>&1
  fi
  rm -f "$ext"
  chmod 600 "$dir/ca.key"
  chmod 644 "$dir/ca.crt.new"
  mv -f "$dir/ca.crt.new" "$dir/ca.crt"
}

issue_leaf() {
  local dir="$1" cn="$2" sans="$3" entry idx=1 ext csr
  local -a lines=() entries=()
  IFS=',' read -ra entries <<<"$sans"
  for entry in "${entries[@]}"; do
    entry="$(printf '%s' "$entry" | tr -d '[:space:]')"
    [[ -z "$entry" || "$entry" == "$cn" ]] && continue
    if [[ "$entry" =~ ^[0-9.]+$ ]]; then lines+=("IP.$idx = $entry"); else lines+=("DNS.$idx = $entry"); fi
    idx=$((idx + 1))
  done
  lines+=("DNS.$idx = $cn")

  ext="$(mktemp "$dir/.leaf-ext.XXXXXX")"
  csr="$(mktemp "$dir/.leaf-csr.XXXXXX")"
  cat > "$ext" <<EOF
[v3_req]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid, issuer
subjectAltName = @alt_names

[alt_names]
$(printf '%s\n' "${lines[@]}")
EOF
  if [[ ! -s "$dir/server.key" ]]; then
    ( umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$dir/server.key" >/dev/null 2>&1 )
  fi
  chmod 600 "$dir/server.key"
  openssl req -new -key "$dir/server.key" -subj "/CN=${cn}" -out "$csr" >/dev/null 2>&1
  openssl x509 -req -in "$csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" -CAcreateserial \
    -CAserial "$dir/ca.srl" -out "$dir/server.crt.new" -days "$LEAF_DAYS" -sha256 \
    -extfile "$ext" -extensions v3_req >/dev/null 2>&1
  rm -f "$ext" "$csr"
  chmod 644 "$dir/server.crt.new"
  mv -f "$dir/server.crt.new" "$dir/server.crt"
  log "issued server.crt for $cn"
}

cmd_issue() {
  local dir="${1:?DIR required}" cn="${2:?CN required}" sans="${3:-localhost,127.0.0.1}" force="${FORCE_LEAF:-0}"
  command -v openssl >/dev/null 2>&1 || die "openssl is required"
  mkdir -p "$dir"
  if ! ca_compliant "$dir/ca.crt" || [[ ! -s "$dir/ca.key" ]]; then
    [[ -s "$dir/ca.crt" && ! -s "$dir/ca.key" ]] &&
      die "$dir/ca.crt exists without ca.key; restore the key or move ca.crt away to mint a new CA"
    issue_ca "$dir" "$cn"
    force=1
  fi
  if [[ "$force" == 1 ]] || ! leaf_compliant "$dir"; then
    issue_leaf "$dir" "$cn" "$sans"
  else
    log "CA and server certificate already pass strict checks; nothing to do"
  fi
  cmd_check "$dir"
}

cmd_check() {
  local dir="${1:?DIR required}" ok=0
  ca_compliant "$dir/ca.crt" || { log "ca.crt fails strict CA checks (basicConstraints/keyUsage/SKI)"; ok=1; }
  leaf_compliant "$dir" || { log "server.crt fails strict leaf checks, does not chain to ca.crt, or expires within 30 days"; ok=1; }
  return "$ok"
}

case "${1:-}" in
  issue) shift; cmd_issue "$@" ;;
  check) shift; cmd_check "$@" ;;
  *) printf 'usage: %s issue DIR CN [SANS] | check DIR\n' "$0" >&2; exit 2 ;;
esac
