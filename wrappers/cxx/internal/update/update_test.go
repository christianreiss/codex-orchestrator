package update

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestInstallVerifiedBinaryIsConcurrentSafe(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	dest := filepath.Join(dir, "cxx")
	if err := os.WriteFile(source, []byte("new common bytes"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dest, []byte("old bytes"), 0o755); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- InstallVerifiedBinary(source, dest)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	want := sha256.Sum256([]byte("new common bytes"))
	if err := VerifyChecksum(dest, hex.EncodeToString(want[:])); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyChecksumRejectsWrongLength(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cxx")
	if err := os.WriteFile(path, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := VerifyChecksum(path, "abcd"); err == nil {
		t.Fatal("expected length error")
	}
}

func TestVerifyChecksumRejectsNonHexDigest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cxx")
	if err := os.WriteFile(path, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := VerifyChecksum(path, "z"+strings.Repeat("0", 63)); err == nil {
		t.Fatal("non-hex digest accepted")
	}
}

func TestSafeRedirectDropsAPIKeyAcrossHosts(t *testing.T) {
	first, _ := http.NewRequest(http.MethodGet, "https://orchestrator.example/cxx", nil)
	next, _ := http.NewRequest(http.MethodGet, "https://cdn.example/cxx", nil)
	next.Header.Set("X-API-Key", "secret")
	if err := safeRedirect(next, []*http.Request{first}); err != nil {
		t.Fatal(err)
	}
	if got := next.Header.Get("X-API-Key"); got != "" {
		t.Fatalf("cross-host API key retained: %q", got)
	}

	same, _ := http.NewRequest(http.MethodGet, "https://orchestrator.example/next", nil)
	same.Header.Set("X-API-Key", "keep")
	if err := safeRedirect(same, []*http.Request{first}); err != nil {
		t.Fatal(err)
	}
	if got := same.Header.Get("X-API-Key"); got != "keep" {
		t.Fatalf("same-host API key changed: %q", got)
	}
}
