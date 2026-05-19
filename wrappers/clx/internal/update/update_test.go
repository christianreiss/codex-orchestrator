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

func TestSetEnvKVAddsAndReplaces(t *testing.T) {
	env := []string{"PATH=/usr/bin", "HOME=/h"}
	env = setEnvKV(env, "FOO", "bar")
	if got := lookup(env, "FOO"); got != "bar" {
		t.Errorf("FOO=%q", got)
	}
	env = setEnvKV(env, "PATH", "/opt/bin")
	if got := lookup(env, "PATH"); got != "/opt/bin" {
		t.Errorf("PATH=%q", got)
	}
	if len(env) != 3 {
		t.Errorf("len=%d", len(env))
	}
}

func lookup(env []string, key string) string {
	prefix := key + "="
	for _, e := range env {
		if len(e) >= len(prefix) && e[:len(prefix)] == prefix {
			return e[len(prefix):]
		}
	}
	return ""
}

func TestReExecAfterUpdateRejectsEmptyExe(t *testing.T) {
	if err := ReExecAfterUpdate("", []string{"a"}); err == nil {
		t.Fatal("expected error on empty exe")
	}
}
