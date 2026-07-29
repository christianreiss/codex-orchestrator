package update

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
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

func TestVerifyChecksumUppercaseMatches(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	body := []byte("clx-binary-bytes")
	_ = os.WriteFile(p, body, 0o644)
	sum := sha256.Sum256(body)
	up := strings.ToUpper(hex.EncodeToString(sum[:]))
	if err := VerifyChecksum(p, up); err != nil {
		t.Fatalf("uppercase digest should match: %v", err)
	}
}

func TestVerifyChecksumMismatchRejected(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	_ = os.WriteFile(p, []byte("real-bytes"), 0o644)
	wrong := sha256.Sum256([]byte("other-bytes"))
	if err := VerifyChecksum(p, hex.EncodeToString(wrong[:])); err == nil {
		t.Fatal("mismatched digest must be rejected")
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

func TestInstallVerifiedBinaryCopiesExecutable(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	dest := filepath.Join(dir, "clx")
	if err := os.WriteFile(src, []byte("new-binary"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dest, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := installVerifiedBinary(src, dest); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "new-binary" {
		t.Fatalf("dest body = %q", body)
	}
	st, err := os.Stat(dest)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o755 {
		t.Fatalf("dest mode = %o, want 755", st.Mode().Perm())
	}
}

func TestInstallVerifiedBinaryReportsSwapFailureWithoutSudo(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	if err := os.WriteFile(src, []byte("new-binary"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	err := installVerifiedBinary(src, filepath.Join(dir, "missing", "clx"))
	if err == nil {
		t.Fatal("expected install failure")
	}
	if !strings.Contains(err.Error(), "atomic swap failed") {
		t.Fatalf("error = %q, want atomic swap context", err.Error())
	}
}
