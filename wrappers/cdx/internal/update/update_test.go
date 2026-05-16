package update

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestVerifyChecksum(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	body := []byte("hello world")
	if err := os.WriteFile(p, body, 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	if err := VerifyChecksum(p, hex.EncodeToString(sum[:])); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if err := VerifyChecksum(p, "00"+hex.EncodeToString(sum[:])[2:]); err == nil {
		t.Fatal("expected mismatch")
	}
}
