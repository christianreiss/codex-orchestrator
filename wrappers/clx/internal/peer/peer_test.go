package peer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
)

// A 403 from /wrapper/v2/config means the peer engine is not enabled for this
// host. fetchBundle must surface the typed sentinel so EnsureForCron can skip
// silently instead of logging a warning on every claude-only host's daily tick.
func TestFetchBundleForbiddenReturnsSentinel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"status":"error","code":"engine_disabled"}`))
	}))
	defer srv.Close()

	cfg := &config.Config{}
	cfg.Orchestrator.BaseURL = srv.URL
	cfg.Orchestrator.APIKey = "k"

	_, _, err := fetchBundle(context.Background(), cfg)
	if !errors.Is(err, errPeerEngineDisabled) {
		t.Fatalf("want errPeerEngineDisabled, got %v", err)
	}
}

// A 200 with a well-formed bundle must decode cleanly (peer engine enabled).
func TestFetchBundleOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"payload":{"wrapper":{"version":"1.2.3"}},"signature":{"value":"sig"}}`))
	}))
	defer srv.Close()

	cfg := &config.Config{}
	cfg.Orchestrator.BaseURL = srv.URL
	cfg.Orchestrator.APIKey = "k"

	b, raw, err := fetchBundle(context.Background(), cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if b.Signature.Value != "sig" || len(raw) == 0 {
		t.Fatalf("bundle not decoded: %+v raw=%q", b, raw)
	}
}

// A non-403 error (e.g. 500) must stay a generic error, not the silent-skip
// sentinel — those should still surface as warnings.
func TestFetchBundleOtherErrorNotSentinel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	cfg := &config.Config{}
	cfg.Orchestrator.BaseURL = srv.URL
	cfg.Orchestrator.APIKey = "k"

	_, _, err := fetchBundle(context.Background(), cfg)
	if err == nil || errors.Is(err, errPeerEngineDisabled) {
		t.Fatalf("want generic error, got %v", err)
	}
}

func TestPeerBinaryCurrentScansShadowedPath(t *testing.T) {
	oldDir := t.TempDir()
	currentDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(oldDir, peerName), []byte("old-cdx"), 0o755); err != nil {
		t.Fatalf("write old peer: %v", err)
	}
	current := []byte("current-cdx")
	if err := os.WriteFile(filepath.Join(currentDir, peerName), current, 0o755); err != nil {
		t.Fatalf("write current peer: %v", err)
	}
	t.Setenv("PATH", oldDir+string(os.PathListSeparator)+currentDir)

	sum := sha256.Sum256(current)
	if !peerBinaryCurrent(hex.EncodeToString(sum[:])) {
		t.Fatal("expected peerBinaryCurrent to find current peer behind stale PATH shadow")
	}
}

func TestShouldRunPeerCronTick(t *testing.T) {
	tests := []struct {
		name          string
		installed     bool
		enginePresent bool
		force         bool
		want          bool
	}{
		{name: "interactive current peer current engine", installed: false, enginePresent: true, force: false, want: false},
		{name: "interactive installed peer", installed: true, enginePresent: true, force: false, want: true},
		{name: "interactive missing engine cli", installed: false, enginePresent: false, force: false, want: true},
		{name: "cron current peer current engine", installed: false, enginePresent: true, force: true, want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldRunPeerCronTick(tt.installed, tt.enginePresent, tt.force); got != tt.want {
				t.Fatalf("want %v, got %v", tt.want, got)
			}
		})
	}
}
