// Package signing embeds the orchestrator's Ed25519 public key for clx.
// Same shape as cdx/internal/signing; deliberately duplicated per topology decision.
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

func PublicKey() (ed25519.PublicKey, error) {
	if len(rawPubKey) == 0 {
		return nil, errors.New("no embedded signing public key")
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

func HasKey() bool {
	_, err := PublicKey()
	return err == nil
}
