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
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ui"
)

func TestUpdateCapsHonorsMinimal(t *testing.T) {
	caps := updateCaps(&config.Config{}, true)
	if caps.IsTTY || !caps.NoColor || !caps.Dumb || caps.UTF8 {
		t.Fatalf("minimal caps must be portable ASCII without terminal styling: %+v", caps)
	}
	if caps.Palette != (ui.Palette{}) {
		t.Fatalf("minimal caps must have an empty palette: %+v", caps.Palette)
	}
}

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

// A bundle whose detached signature does not verify against the embedded fleet
// key must be rejected before any peer config is written or peer binary is
// downloaded/executed. Without this gate the downstream sha256 check is
// worthless (the hash rides in the same unverified payload).
func TestInstallPeerRejectsBadSignature(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"payload":{"wrapper":{"binary_url":"http://x/cdx","binary_sha256":"` +
			"0000000000000000000000000000000000000000000000000000000000000000" +
			`"}},"signature":{"value":"not-a-valid-signature"}}`))
	}))
	defer srv.Close()

	cfgPath := filepath.Join(t.TempDir(), "cdx.json")
	t.Setenv("CDX_CONFIG_PATH", cfgPath)

	cfg := &config.Config{}
	cfg.Orchestrator.BaseURL = srv.URL
	cfg.Orchestrator.APIKey = "k"

	err := installPeer(context.Background(), cfg, false, false)
	if err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("want signature-invalid error, got %v", err)
	}
	if _, statErr := os.Stat(cfgPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("peer config must not be written on signature failure (stat=%v)", statErr)
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
