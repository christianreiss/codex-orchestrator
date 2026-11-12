package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/installspace"
	"net/http"
	"net/http/httptest"
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

func TestDownloadAuthRequiresMatchingOrigin(t *testing.T) {
	for _, tc := range []struct {
		target, base string
		want         bool
	}{
		{"https://fleet.example:443/cxx", "https://FLEET.example", true},
		{"http://fleet.example/cxx", "https://fleet.example", false},
		{"https://fleet.example:444/cxx", "https://fleet.example", false},
		{"https://cdn.example/cxx", "https://fleet.example", false},
		{"https://user@fleet.example/cxx", "https://fleet.example", false},
	} {
		if got := sameHost(tc.target, tc.base); got != tc.want {
			t.Errorf("%s => %v", tc.target, got)
		}
	}
}

func TestPrefetchSpaceFailureNeverWritesBody(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var sent int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sent++
		w.Header().Set("Content-Length", "3")
		_, _ = w.Write([]byte("new"))
	}))
	defer srv.Close()
	cfg := &config.Config{}
	ctx := installspace.WithProbe(context.Background(), func(string) (installspace.Capacity, error) { return installspace.Capacity{}, nil })
	hash := strings.Repeat("a", 64)
	if _, err := Prefetch(ctx, cfg, srv.URL, hash, "1.0.0"); !installspace.IsCapacity(err) {
		t.Fatalf("capacity gate: %v", err)
	}
	// Only response headers may have been fetched; nothing is staged or published.
	if sent > 1 {
		t.Fatalf("unexpected downloads %d", sent)
	}
	dest, _ := StagedPath(hash)
	entries, _ := os.ReadDir(filepath.Dir(dest))
	if len(entries) != 0 {
		t.Fatalf("left partial prefetch: %v", entries)
	}
}

func TestStagingSpaceFailureCanUseAnotherFilesystem(t *testing.T) {
	first, second, target := t.TempDir(), t.TempDir(), t.TempDir()
	ctx := installspace.WithProbe(context.Background(), func(path string) (installspace.Capacity, error) {
		if path == first {
			return installspace.Capacity{Device: 1, Bytes: 0}, nil
		}
		return installspace.Capacity{Device: 2, Bytes: 4 * installspace.Native}, nil
	})
	file, index, err := createStageFileWithSpace(ctx, []stageDir{{path: first}, {path: second}}, filepath.Join(target, "cxx"), installspace.MiB)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if index != 1 {
		t.Fatalf("staged on full filesystem: %d", index)
	}
}

func TestNoexecFallbackPreservesCapacityFailure(t *testing.T) {
	source := filepath.Join(t.TempDir(), "not-executable")
	if err := os.WriteFile(source, []byte("#!/bin/sh\necho 1.0.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx := installspace.WithProbe(context.Background(), func(string) (installspace.Capacity, error) { return installspace.Capacity{}, nil })
	_, cleanup, err := verifyStagedExecutable(ctx, source, []stageDir{{path: t.TempDir()}})
	cleanup()
	if !installspace.IsCapacity(err) {
		t.Fatalf("noexec hid the fallback capacity failure: %v", err)
	}
}
