package cron

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
)

func TestShellEscape(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"/usr/local/bin/cdx", "/usr/local/bin/cdx"},
		{"/home/jane/.codex/cron.log", "/home/jane/.codex/cron.log"},
		{"/path with spaces/cdx", "'/path with spaces/cdx'"},
		{"/oh'no/cdx", `'/oh'\''no/cdx'`},
		{"", "''"},
	}
	for _, tc := range cases {
		got := shellEscape(tc.in)
		if got != tc.want {
			t.Errorf("shellEscape(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestBuildCronLineEscapesPercentAndPaths(t *testing.T) {
	line := buildCronLine(7, 3, "/usr/local/bin/cdx", "/var/log/some 50% file.log")
	if !strings.Contains(line, "# cdx-managed-cron") {
		t.Errorf("missing marker: %q", line)
	}
	if !strings.Contains(line, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin") {
		t.Errorf("missing cron PATH bootstrap: %q", line)
	}
	if !strings.Contains(line, `\%`) {
		t.Errorf("expected escaped percent in line: %q", line)
	}
	if strings.Contains(line, "50%f") || strings.Contains(line, " 50% file") {
		t.Errorf("unescaped percent leaked through: %q", line)
	}
	if !strings.HasPrefix(line, "7 3 * * * ") {
		t.Errorf("schedule prefix wrong: %q", line)
	}
}

func TestEnsureCronPathPrependsLocalBin(t *testing.T) {
	t.Setenv("PATH", "/usr/bin:/bin")
	ensureCronPath()
	got := strings.Split(os.Getenv("PATH"), ":")
	want := []string{"/usr/local/sbin", "/usr/local/bin", "/usr/bin", "/bin"}
	if strings.Join(got, ":") != strings.Join(want, ":") {
		t.Fatalf("PATH = %q, want %q", strings.Join(got, ":"), strings.Join(want, ":"))
	}
}

func TestInstallWrapperTempReplacesDestination(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "cdx")
	if err := os.WriteFile(dest, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	tmp, f, err := createWrapperTemp(dest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("new"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := installWrapperTemp(tmp, dest); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new" {
		t.Fatalf("dest = %q, want new", got)
	}
}

func TestStripManagedDropsMarkedLine(t *testing.T) {
	in := "5 * * * * /something else\n" +
		"7 3 * * * /usr/local/bin/cdx --cron run >> /tmp/x 2>&1 # cdx-managed-cron\n" +
		"\n"
	got := stripManaged(in)
	if len(got) != 1 || !strings.Contains(got[0], "/something else") {
		t.Errorf("stripManaged = %v", got)
	}
}

func TestResolveURL(t *testing.T) {
	cases := []struct {
		base, in, want string
	}{
		{"https://orc.example", "https://other/x", "https://other/x"},
		{"https://orc.example", "/wrapper/v2/download", "https://orc.example/wrapper/v2/download"},
		{"https://orc.example/", "/wrapper/v2/download", "https://orc.example/wrapper/v2/download"},
		{"https://orc.example", "wrapper/v2/download", "https://orc.example/wrapper/v2/download"},
	}
	for _, tc := range cases {
		got := resolveURL(tc.base, tc.in)
		if got != tc.want {
			t.Errorf("resolveURL(%q,%q)=%q want %q", tc.base, tc.in, got, tc.want)
		}
	}
}

// minimalCfg is a hand-crafted config struct that bypasses the loader and
// signature verification — it's only used to drive Tick against an httptest
// server.
func minimalCfg(baseURL string) *config.Config {
	return &config.Config{
		SchemaVersion: config.SchemaVersion,
		Engine:        config.EngineCodex,
		Orchestrator: config.Orchestrator{
			BaseURL: baseURL,
			APIKey:  "sk-cdx-test-12345",
		},
		Host: config.Host{ID: 1, FQDN: "h.test"},
		Wrapper: config.Wrapper{
			Version:      "dev",
			BinaryURL:    "https://example.invalid/x",
			BinarySHA256: strings.Repeat("a", 64),
		},
	}
}

func TestTickNoUpdateReportsAndReturns(t *testing.T) {
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist") // codex.Version() returns "unknown"
	t.Setenv("PATH", "")

	var checkCalls, reportCalls int32
	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&checkCalls, 1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "no_update",
			"wrapper": map[string]any{
				"action": "no_update",
			},
		})
	})
	mux.HandleFunc("/cron/report", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&reportCalls, 1)
		body, _ := readAll(r)
		if !strings.Contains(body, `"engine":"codex"`) {
			t.Errorf("report missing engine: %s", body)
		}
		_, _ = w.Write([]byte(`{"recorded":true}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	cfg := minimalCfg(srv.URL)
	res, err := Tick(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if !res.Reported {
		t.Errorf("expected Reported=true; got %+v", res)
	}
	if checkCalls != 1 || reportCalls != 1 {
		t.Errorf("calls: check=%d report=%d", checkCalls, reportCalls)
	}
}

func TestTickDisableRemovesCron(t *testing.T) {
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")
	t.Setenv("PATH", "")
	previousRemoveSchedule := removeSchedule
	removeCalls := 0
	removeSchedule = func() error {
		removeCalls++
		return nil
	}
	t.Cleanup(func() { removeSchedule = previousRemoveSchedule })

	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "disable",
			"wrapper": map[string]any{
				"action": "no_update",
			},
		})
	})
	mux.HandleFunc("/cron/report", func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("report should not be called when disabled")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	cfg := minimalCfg(srv.URL)
	res, err := Tick(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Tick disable: %v", err)
	}
	if res.WrapperAction != "disable" || res.CodexAction != "disable" {
		t.Errorf("expected disabled actions; got %+v", res)
	}
	if removeCalls != 1 {
		t.Errorf("remove calls = %d, want 1", removeCalls)
	}
}

func TestTickWrapperUpdateLoopGuard(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTARTED", "1")
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")
	t.Setenv("PATH", "")

	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "no_update",
			"wrapper": map[string]any{
				"action":         "update",
				"target_version": "9.9.9",
				"sha256":         strings.Repeat("a", 64),
				"url":            "/wrapper/v2/download/cdx",
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	cfg := minimalCfg(srv.URL)
	_, err := Tick(context.Background(), cfg)
	if err == nil {
		t.Fatal("expected loop-detected error")
	}
	if !strings.Contains(err.Error(), "wrapper update loop detected") {
		t.Errorf("unexpected err: %v", err)
	}
}

func TestTickWrapperUpdateRefusesIncompleteMetadata(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTARTED", "")
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")
	t.Setenv("PATH", "")

	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "no_update",
			"wrapper": map[string]any{
				"action":         "update",
				"target_version": "9.9.9",
				// missing sha256/url on purpose
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	cfg := minimalCfg(srv.URL)
	_, err := Tick(context.Background(), cfg)
	if err == nil {
		t.Fatal("expected metadata-incomplete error")
	}
	if !strings.Contains(err.Error(), "metadata incomplete") {
		t.Errorf("unexpected err: %v", err)
	}
}

func TestTickReportRetriesThenFails(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTARTED", "")
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")
	t.Setenv("PATH", "")

	var reportCalls int32
	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "no_update",
			"wrapper": map[string]any{
				"action": "no_update",
			},
		})
	})
	mux.HandleFunc("/cron/report", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&reportCalls, 1)
		w.WriteHeader(500)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	cfg := minimalCfg(srv.URL)
	// Shorten time.After by using a cancellable context that completes after
	// the second attempt. The 2s retry sleep will be cut short by ctx.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		// Wait long enough for at least one /cron/check + first /cron/report.
		// Then cancel during the 2s backoff before the second report attempt.
		for atomic.LoadInt32(&reportCalls) < 1 {
		}
		cancel()
	}()
	_, err := Tick(ctx, cfg)
	if err == nil {
		t.Fatal("expected report failure error")
	}
}

func readAll(r *http.Request) (string, error) {
	b := make([]byte, 4096)
	n, _ := r.Body.Read(b)
	return string(b[:n]), nil
}

func TestInstallUserContextPrefersSudoUser(t *testing.T) {
	// When running under `sudo cdx --cron install`, $SUDO_USER points back at
	// the human operator; we want the cron entry pinned to *their* config + log
	// dir, not root's.
	t.Setenv("SUDO_USER", "alice")
	origLookup := userLookup
	t.Cleanup(func() { userLookup = origLookup })
	userLookup = func(name string) (*user.User, error) {
		if name != "alice" {
			t.Fatalf("expected lookup for alice, got %q", name)
		}
		return &user.User{Username: "alice", HomeDir: "/home/alice"}, nil
	}
	name, home := installUserContext()
	if name != "alice" {
		t.Errorf("name=%q want alice", name)
	}
	if home != "/home/alice" {
		t.Errorf("home=%q want /home/alice", home)
	}
}

func TestInstallUserContextIgnoresRootSudoUser(t *testing.T) {
	// SUDO_USER=root happens when root sudo's to itself — meaningless; fall
	// back to the current process's user record.
	t.Setenv("SUDO_USER", "root")
	origCurrent := userCurrent
	t.Cleanup(func() { userCurrent = origCurrent })
	userCurrent = func() (*user.User, error) {
		return &user.User{Username: "root", HomeDir: "/root"}, nil
	}
	_, home := installUserContext()
	if home != "/root" {
		t.Errorf("home=%q want /root (fell back to current)", home)
	}
}
