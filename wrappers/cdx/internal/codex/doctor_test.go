package codex

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ui"
)

func TestCheckCLIUsesRunningWrapperVersion(t *testing.T) {
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")

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

func TestCheckPathsFailsWhenUpstreamCLIIsMissing(t *testing.T) {
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")

	row := checkPaths()

	if row.Tone != ui.ToneFail || !strings.Contains(row.Value, "codex unavailable") {
		t.Fatalf("missing upstream CLI was not reported truthfully: %#v", row)
	}
}

func TestCheckCLIWarnsWhenVersionProbeFails(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(bin, []byte("not executable"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", bin)

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
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")

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

func TestCheckAuthRejectsFreshInvalidCredentials(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".codex", "auth.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"last_refresh":"2099-01-01T00:00:00Z"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	row := checkAuth()
	if row.Tone != ui.ToneFail || !strings.Contains(row.Value, "no usable Codex token") {
		t.Fatalf("fresh invalid auth.json was not failed: %#v", row)
	}
}

func TestCheckConfigParsesTOML(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		body string
		tone ui.Tone
	}{
		{name: "empty", body: "", tone: ui.ToneFail},
		{name: "malformed", body: "model = [", tone: ui.ToneFail},
		{name: "valid", body: "model = \"gpt-5.6-terra\"\n", tone: ui.ToneOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(tc.body), 0o600); err != nil {
				t.Fatal(err)
			}
			if got := checkConfig(); got.Tone != tc.tone {
				t.Fatalf("checkConfig() = %#v, want tone %q", got, tc.tone)
			}
		})
	}
}

func TestCheckMCPUsesParsedSectionScope(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		body string
		tone ui.Tone
	}{
		{name: "comment only", body: "# [mcp_servers.cdx]\n", tone: ui.ToneWarn},
		{name: "unrelated disabled", body: "[other]\nenabled = false\n[mcp_servers.cdx]\ncommand = \"cdx\"\n", tone: ui.ToneOK},
		{name: "scoped disabled", body: "[mcp_servers.cdx]\nenabled = false\n", tone: ui.ToneWarn},
		{name: "malformed", body: "[mcp_servers.cdx\n", tone: ui.ToneFail},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(tc.body), 0o600); err != nil {
				t.Fatal(err)
			}
			var hints []string
			if got := checkMCP(&hints); got.Tone != tc.tone {
				t.Fatalf("checkMCP() = %#v, want tone %q", got, tc.tone)
			}
		})
	}
}

// TestTallyRows pins the doctor verdict to EVERY row's tone — the regression
// that let a red Disk/Sync row (or a ⚠ Cron row) coexist with an
// "all checks passed" / exit-0 result.
func TestTallyRows(t *testing.T) {
	mk := func(tones ...ui.Tone) []ui.DoctorRow {
		rows := make([]ui.DoctorRow, len(tones))
		for i, tone := range tones {
			rows[i] = ui.DoctorRow{Tone: tone}
		}
		return rows
	}
	cases := []struct {
		name      string
		rows      []ui.DoctorRow
		wantFail  int
		wantWorst ui.Tone
	}{
		{"all ok", mk(ui.ToneOK, ui.ToneOK), 0, ui.ToneOK},
		{"trailing disk fail counts", mk(ui.ToneOK, ui.ToneOK, ui.ToneFail), 1, ui.ToneFail},
		{"cron warn downgrades verdict", mk(ui.ToneOK, ui.ToneWarn), 0, ui.ToneWarn},
		{"fail dominates warn", mk(ui.ToneWarn, ui.ToneFail, ui.ToneWarn), 1, ui.ToneFail},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotFail, gotWorst := tallyRows(tc.rows)
			if gotFail != tc.wantFail || gotWorst != tc.wantWorst {
				t.Fatalf("tallyRows = (%d,%v), want (%d,%v)", gotFail, gotWorst, tc.wantFail, tc.wantWorst)
			}
		})
	}
}
