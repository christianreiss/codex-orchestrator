#!/usr/bin/env bash
# Generate the Ed25519 keypair used by the wrapper bakery v2.
#
# Run ONCE per environment, then commit the generated public key into the
# Go embed slots via `cd wrappers && make pubkey`. The private key STAYS on
# the orchestrator host and never leaves it.
#
# Re-running rotates the key. Existing hosts running a binary that embeds the
# old public key will refuse signed configs until they self-update.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_DIR="$ROOT/storage/wrapper/v2/keys"
PRIV="$KEY_DIR/signing.ed25519"
PUB="$KEY_DIR/signing.ed25519.pub"

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

if [[ -f "$PRIV" ]]; then
  echo "[wrapper-v2-init-keys] $PRIV already exists; refusing to overwrite." >&2
  echo "                       remove it (and rotate hosts) to regenerate." >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "[wrapper-v2-init-keys] openssl required" >&2
  exit 1
fi

# Use openssl genpkey: produces a PKCS#8 PEM-encoded Ed25519 private key.
openssl genpkey -algorithm Ed25519 -outform PEM -out "$PRIV"
openssl pkey -in "$PRIV" -pubout -outform PEM -out "$PUB"

chmod 600 "$PRIV"
chmod 644 "$PUB"

echo "Generated:"
echo "  private key: $PRIV (chmod 600)"
echo "  public key:  $PUB"
echo
echo "Next: cd wrappers && make pubkey   # propagate pubkey into the Go binaries"
