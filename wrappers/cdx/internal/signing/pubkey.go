// Package signing embeds the orchestrator's Ed25519 public key at build time
// and exposes it as a verifier. The orchestrator never has to push the key —
// rotating the signing key requires re-downloading the binary.
package signing

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	_ "embed"
)

//go:embed pubkey.pem
var rawPubKey []byte

// PublicKey returns the embedded Ed25519 public key, or an error if the
// embedded pubkey file is missing/invalid. A binary built without a real key
// is still callable (so `make cdx` in a fresh checkout works), but it will
// refuse to verify any config — which is the safe default.
func PublicKey() (ed25519.PublicKey, error) {
	if len(rawPubKey) == 0 {
		return nil, errors.New("no embedded signing public key (run `make pubkey` after wrapper-v2-init-keys.sh)")
	}
	block, _ := pem.Decode(rawPubKey)
	if block == nil {
		return nil, errors.New("embedded signing pubkey is not PEM-encoded")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	pk, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("embedded signing pubkey is not Ed25519")
	}
	return pk, nil
}

// HasKey reports whether a real key is embedded (used by tests / doctor).
func HasKey() bool {
	_, err := PublicKey()
	return err == nil
}
