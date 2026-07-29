package update

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
)

func TestSetEnvKVAddsAndReplaces(t *testing.T) {
	env := []string{"PATH=/usr/bin", "HOME=/h"}
	env = setEnvKV(env, "FOO", "bar")
	got := lookup(env, "FOO")
	if got != "bar" {
		t.Errorf("FOO=%q", got)
	}
	env = setEnvKV(env, "PATH", "/opt/bin")
	got = lookup(env, "PATH")
	if got != "/opt/bin" {
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

func TestReExecAfterUpdateFailurePreservesInsecurePurgeOwnership(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	authPath := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(authPath, []byte(`{"tokens":{"access_token":"temporary"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	session, err := codex.StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	if err := ReExecAfterUpdate(filepath.Join(dir, "does-not-exist"), []string{"run"}); err == nil {
		t.Fatal("expected syscall.Exec failure")
	}

	// The failed handoff must re-enable sessions and leave the original purge
	// ID intact; otherwise the normal deferred finish would retain auth.
	peer, err := codex.AcquireAuthSession()
	if err != nil {
		t.Fatalf("failed exec left session registry frozen: %v", err)
	}
	if _, _, err := codex.FinishAuthSession(peer); err != nil {
		t.Fatal(err)
	}
	removed, deferred, err := codex.FinishAuthSession(session)
	if err != nil || !removed || deferred {
		t.Fatalf("finish after failed exec = removed=%v deferred=%v err=%v", removed, deferred, err)
	}
	if _, err := os.Stat(authPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed exec lost insecure purge request: %v", err)
	}
}

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
