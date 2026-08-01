// Package signing embeds the orchestrator's Ed25519 public key at build time
// and exposes it as a verifier. The orchestrator never has to push the key —
// rotating the signing key requires re-downloading the binary.
package signing

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	_ "embed"
	"encoding/pem"
	"errors"
)

//go:embed pubkey.pem
var rawPubKey []byte

// buildPublicKeyB64 is set with -ldflags for installation-specific builds.
// Keeping this separate from pubkey.pem lets bin/setup.sh build a uniquely
// trusted fleet without ever rewriting a tracked source file.
var buildPublicKeyB64 string

// PublicKey returns the embedded Ed25519 public key, or an error if the
// embedded pubkey file is missing/invalid. A binary built without a real key
// is still callable (so `make cdx` in a fresh checkout works), but it will
// refuse to verify any config — which is the safe default.
func PublicKey() (ed25519.PublicKey, error) {
	material := rawPubKey
	if buildPublicKeyB64 != "" {
		decoded, err := base64.StdEncoding.DecodeString(buildPublicKeyB64)
		if err != nil {
			return nil, errors.New("build signing pubkey is not valid base64")
		}
		material = decoded
	}
	if len(material) == 0 {
		return nil, errors.New("no embedded signing public key (build with PUBLIC_KEY_FILE)")
	}
	block, _ := pem.Decode(material)
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
