package lifecycle

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// fixtureBearerConfig mirrors the shape of a baked config.toml: the managed
// stdio MCP entry carries the fleet bearer in its env table. The value is a
// fixture, never a real credential.
const fixtureBearerConfig = "model = \"fleet\"\n\n[mcp_servers.cdx]\ncommand = \"cxx\"\n\n[mcp_servers.cdx.env]\nCXX_MCP_BEARER = \"fixture-bearer\"\n"

// customHomeSyncHost points CODEX_HOME at a scratch directory outside HOME, the
// way an operator isolating a CLI check does, and serves the given config body.
func customHomeSyncHost(t *testing.T, configBody string) (*config.Config, string) {
	t.Helper()
	home := t.TempDir()
	codexHome := filepath.Join(t.TempDir(), "scratch-codex")
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CODEX_ALLOW_FQDN_MISMATCH", "1")
	if err := codex.WriteAuth(json.RawMessage(`{"last_refresh":"2099-01-01T00:00:00Z","tokens":{"access_token":"live"}}`)); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{
		"status": "ok",
		"agents": "# fleet agents\n",
		"config": configBody,
		"auth":   map[string]any{"status": "valid", "verification_state": "verified", "host": map[string]any{"secure": true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/skills":
			_, _ = io.WriteString(w, `{"skills":[]}`)
		case "/sync/bootstrap":
			_, _ = w.Write(payload)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"}}, codexHome
}

func syncOnly(t *testing.T, cfg *config.Config) {
	t.Helper()
	exit, err := Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if exit != 0 || err != nil {
		t.Fatalf("Run(SyncOnly) = (%d, %v), want (0, nil)", exit, err)
	}
}

// TestSyncedConfigTomlIsPrivate pins that the baked config.toml, which carries
// the managed MCP bearer, is never group- or world-readable in any Codex home,
// including a scratch CODEX_HOME under a shared temporary directory. clx
// (settings.json) and cgx (runtime config.toml) already write theirs 0600.
func TestSyncedConfigTomlIsPrivate(t *testing.T) {
	cfg, codexHome := customHomeSyncHost(t, fixtureBearerConfig)
	syncOnly(t, cfg)
	info, err := os.Stat(filepath.Join(codexHome, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config.toml mode = %o, want 600", perm)
	}
}

// TestUnchangedConfigTomlIsTightened covers the hosts that already hold a 0644
// config.toml: an unchanged digest is never rewritten, so the sync must still
// remove group and world access from the existing file.
func TestUnchangedConfigTomlIsTightened(t *testing.T) {
	cfg, codexHome := customHomeSyncHost(t, "")
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(codexHome, "config.toml")
	if err := os.WriteFile(path, []byte(fixtureBearerConfig), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	syncOnly(t, cfg)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("unchanged config.toml mode = %o, want 600", perm)
	}
}

func TestRestrictConfigModeLeavesSymlinkTargetsAlone(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "dotfiles-config.toml")
	if err := os.WriteFile(target, []byte("model = \"x\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(target, 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "config.toml")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := restrictConfigMode(link); err != nil {
		t.Fatal(err)
	}
	if err := restrictConfigMode(filepath.Join(dir, "absent.toml")); err != nil {
		t.Fatalf("absent config: %v", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o644 {
		t.Fatalf("symlink target mode changed to %o", perm)
	}
}
