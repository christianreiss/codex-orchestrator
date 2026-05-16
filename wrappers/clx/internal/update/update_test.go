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
	body := []byte("clx-binary-bytes")
	_ = os.WriteFile(p, body, 0o644)
	sum := sha256.Sum256(body)
	if err := VerifyChecksum(p, hex.EncodeToString(sum[:])); err != nil {
		t.Fatal(err)
	}
}
