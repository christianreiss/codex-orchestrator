package signing

import (
	"crypto/ed25519"
	"testing"
)

// Build-integrity canary: a corrupt or empty embedded pubkey.pem silently
// downgrades cdx to "refuses signed configs" (and the version banner prints
// "MISSING"). Catch that at test time instead of in the field.
func TestPublicKeyEmbeddedAndWellFormed(t *testing.T) {
	pk, err := PublicKey()
	if err != nil {
		t.Fatalf("embedded signing pubkey must parse: %v", err)
	}
	if len(pk) != ed25519.PublicKeySize {
		t.Fatalf("ed25519 pubkey size = %d, want %d", len(pk), ed25519.PublicKeySize)
	}
	if !HasKey() {
		t.Fatal("HasKey() must be true with a valid embedded key")
	}
}
