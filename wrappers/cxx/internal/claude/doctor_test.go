package claude

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
)

func TestCheckCLIUsesRunningWrapperVersion(t *testing.T) {
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")

	row := checkCLI(context.Background(), &config.Config{Wrapper: config.Wrapper{Version: "0.6.5"}}, "0.6.15")

	if row.Tone != ui.ToneFail {
		t.Fatalf("missing upstream CLI should fail, got tone %q", row.Tone)
	}
	if !strings.Contains(row.Value, "wrapper=0.6.15") {
		t.Fatalf("expected running wrapper version, got %q", row.Value)
	}
	if strings.Contains(row.Value, "wrapper=0.6.5") {
		t.Fatalf("doctor leaked stale config wrapper version: %q", row.Value)
	}
}

func TestCheckPathsFailsWhenUpstreamCLIIsMissing(t *testing.T) {
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")

	row := checkPaths()

	if row.Tone != ui.ToneFail || !strings.Contains(row.Value, "claude unavailable") {
		t.Fatalf("missing upstream CLI was not reported truthfully: %#v", row)
	}
}

func TestCheckCLIWarnsWhenVersionProbeFails(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(bin, []byte("not executable"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)

	row := checkCLI(context.Background(), nil, "0.6.15")

	if row.Tone != ui.ToneWarn || !strings.Contains(row.Value, "version probe failed") {
		t.Fatalf("failed version probe was not reported as a warning: %#v", row)
	}
}

func TestDependencySummaryDoesNotDuplicateStatusIcons(t *testing.T) {
	got := dependencySummary([]string{"curl"}, []string{"node"})
	if strings.ContainsAny(got, "✅⚠⛔") {
		t.Fatalf("dependency value contains a second status icon: %q", got)
	}
	if got != "available: curl; missing: node" {
		t.Fatalf("dependencySummary = %q", got)
	}
}

func TestCheckCLIFallsBackToConfigWrapperVersion(t *testing.T) {
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")

	row := checkCLI(context.Background(), &config.Config{Wrapper: config.Wrapper{Version: "0.6.5"}}, "")

	if !strings.Contains(row.Value, "wrapper=0.6.5") {
		t.Fatalf("expected config fallback wrapper version, got %q", row.Value)
	}
}

func TestDoctorCapsHonorsExplicitMinimal(t *testing.T) {
	rich := ui.Caps{
		IsTTY:   true,
		UTF8:    true,
		Columns: 120,
		Palette: ui.Palette{Bold: "\x1b[1m", Reset: "\x1b[0m", Green: "\x1b[32m"},
	}
	got := doctorCaps(rich, true)
	if got.IsTTY || !got.NoColor || !got.Dumb || got.UTF8 || got.Palette != (ui.Palette{}) {
		t.Fatalf("minimal doctor retained rich capabilities: %+v", got)
	}
	if unchanged := doctorCaps(rich, false); unchanged != rich {
		t.Fatalf("normal doctor capabilities changed: got=%+v want=%+v", unchanged, rich)
	}
}

func TestTallyRows(t *testing.T) {
	rows := []ui.DoctorRow{
		{Tone: ui.ToneOK},
		{Tone: ui.ToneWarn},
		{Tone: ui.ToneFail},
	}

	failures, worst := tallyRows(rows)
	if failures != 1 || worst != ui.ToneFail {
		t.Fatalf("tallyRows = (%d, %q), want (1, %q)", failures, worst, ui.ToneFail)
	}
}

func TestCheckAuthRejectsFreshInvalidCredentials(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".claude", ".credentials.json")
	writeDoctorFixture(t, path, `{"last_refresh":"2099-01-01T00:00:00Z"}`)

	row := checkAuth()

	if row.Tone != ui.ToneFail || !strings.Contains(row.Value, "no usable Claude token") {
		t.Fatalf("fresh invalid credentials were not failed: %#v", row)
	}
}

func TestCheckConfigRejectsMalformedJSON(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeDoctorFixture(t, filepath.Join(home, ".claude", "settings.json"), `{"model":`)

	row := checkConfig()

	if row.Tone != ui.ToneFail || !strings.Contains(row.Value, "not a valid JSON object") {
		t.Fatalf("malformed settings.json was not failed: %#v", row)
	}
}

func TestCheckMCPRequiresExactManagedObject(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".claude.json")
	// This contains every string the old substring check looked for, but there
	// is no mcpServers.clx object.
	writeDoctorFixture(t, path, `{"mcpServers":{"other":{"label":"clx"}},"codex-orchestrator":"noise"}`)

	row := checkMCP(&[]string{})

	if row.Tone == ui.ToneOK {
		t.Fatalf("MCP substring false positive was reported configured: %#v", row)
	}

	writeDoctorFixture(t, path, `{"mcpServers":{"clx":{"type":"http","url":"https://orchestrator.example/mcp"}}}`)
	row = checkMCP(&[]string{})
	if row.Tone != ui.ToneOK {
		t.Fatalf("exact mcpServers.clx object was not accepted: %#v", row)
	}
}

func TestCheckAPITruthfulHTTPAndTransportTones(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	t.Run("connection refusal", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		baseURL := server.URL
		server.Close()

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		api, latency, syncTone, _ := checkAPI(ctx, doctorConfig(baseURL))

		if api.Tone != ui.ToneFail || latency.Tone != ui.ToneFail || syncTone != ui.ToneFail {
			t.Fatalf("connection refusal tones = api:%q latency:%q sync:%q", api.Tone, latency.Tone, syncTone)
		}
	})

	t.Run("http 401", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
		}))
		defer server.Close()

		api, latency, syncTone, _ := checkAPI(context.Background(), doctorConfig(server.URL))

		if api.Tone != ui.ToneFail || !strings.Contains(api.Value, "http 401") {
			t.Fatalf("401 API row was not failed: %#v", api)
		}
		if latency.Tone == ui.ToneFail {
			t.Fatalf("responsive 401 endpoint was mislabeled unreachable: %#v", latency)
		}
		if syncTone != ui.ToneFail {
			t.Fatalf("401 auth probe tone = %q, want fail", syncTone)
		}
	})

	t.Run("http 200", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Path == "/auth" {
				_, _ = w.Write([]byte(`{"status":"valid"}`))
				return
			}
			_, _ = w.Write([]byte(`{}`))
		}))
		defer server.Close()

		api, latency, syncTone, _ := checkAPI(context.Background(), doctorConfig(server.URL))

		if api.Tone != ui.ToneOK || latency.Tone != ui.ToneOK || syncTone != ui.ToneOK {
			t.Fatalf("healthy API tones = api:%q latency:%q sync:%q", api.Tone, latency.Tone, syncTone)
		}
	})
}

func doctorConfig(baseURL string) *config.Config {
	return &config.Config{Orchestrator: config.Orchestrator{BaseURL: baseURL, APIKey: "test-key"}}
}

func writeDoctorFixture(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}
