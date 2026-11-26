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

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/ui"
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

func TestDoctorReportsACodexPoolProblem(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", "")
	t.Setenv("CXX_PROVIDER_SESSION_ID", "")
	serve := func(list string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Path {
			case "/auth":
				_, _ = w.Write([]byte(`{"status":"valid","account_id":2,"quota_limit_percent":95,"quota_pool":{"accounts":` + list + `}}`))
			case "/auth/accounts":
				if r.URL.Query().Get("engine") != "codex" {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				_, _ = w.Write([]byte(`{"engine":"codex","policy":{"mode":"manual"},"bound_account_id":null,"accounts":` + list + `}`))
			default:
				_, _ = w.Write([]byte(`{}`))
			}
		}))
	}
	healthy := serve(`[{"id":2,"state":"enabled","verified":true,"score":88},{"id":5,"state":"enabled","verified":true,"score":20}]`)
	defer healthy.Close()
	if _, _, _, _, pool := probeAPI(context.Background(), doctorConfig(healthy.URL)); pool == nil || pool.row.Tone != ui.ToneOK || pool.row.Value != "2 accounts, 2 usable; policy manual; #2 88%, #5 20%" {
		t.Fatalf("healthy pool: %+v", pool)
	}
	broken := serve(`[{"id":2,"state":"paused","verified":true},{"id":5,"state":"enabled","verified":false}]`)
	defer broken.Close()
	_, _, _, _, pool := probeAPI(context.Background(), doctorConfig(broken.URL))
	if pool == nil || pool.row.Tone != ui.ToneFail || strings.Contains(pool.hint, "accounts add") {
		t.Fatalf("no usable account: %+v", pool)
	}
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

func TestCheckCLIFallsBackToConfigWrapperVersion(t *testing.T) {
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")

	row := checkCLI(context.Background(), &config.Config{Wrapper: config.Wrapper{Version: "0.6.5"}}, "")

	if !strings.Contains(row.Value, "wrapper=0.6.5") {
		t.Fatalf("expected config fallback wrapper version, got %q", row.Value)
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
