package cron

import (
	"context"
	"encoding/json"
	"hash/crc32"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
)

func TestShellEscape(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"/usr/local/bin/clx", "/usr/local/bin/clx"},
		{"/path with spaces/clx", "'/path with spaces/clx'"},
		{"/oh'no/clx", `'/oh'\''no/clx'`},
	}
	for _, tc := range cases {
		if got := shellEscape(tc.in); got != tc.want {
			t.Errorf("shellEscape(%q)=%q want %q", tc.in, got, tc.want)
		}
	}
}

func TestBuildCronLineEscapesPercent(t *testing.T) {
	line := buildCronLine(7, 3, "/usr/local/bin/clx", "/var/log/50% file.log")
	if !strings.Contains(line, "# clx-managed-cron") {
		t.Errorf("missing marker: %q", line)
	}
	if !strings.Contains(line, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin") {
		t.Errorf("missing cron PATH bootstrap: %q", line)
	}
	if !strings.Contains(line, `\%`) {
		t.Errorf("expected escaped percent: %q", line)
	}
}

// clx and cdx share the crc32(hostname) derivation; the offset is the only
// thing keeping a dual-engine host from running both ticks in the same minute.
func TestDeterministicTimeStaggersAwayFromCdx(t *testing.T) {
	for _, host := range []string{"", "amnesiac", "crane.alpha-labs.net", "h.test"} {
		key := host
		if key == "" {
			key = "unknown"
		}
		sum := crc32.ChecksumIEEE([]byte(key))
		cdxMin, cdxHr := int(sum%60), int((sum/60)%4)
		min, hr := deterministicTime(host)
		if min == cdxMin && hr == cdxHr {
			t.Errorf("host %q: clx slot %d:%d collides with cdx", host, hr, min)
		}
		if want := (cdxMin + slotOffsetMinutes) % 60; min != want {
			t.Errorf("host %q: min = %d, want %d", host, min, want)
		}
		if hr != cdxHr {
			t.Errorf("host %q: hr = %d, want %d (hour must not move)", host, hr, cdxHr)
		}
		if min < 0 || min > 59 || hr < 0 || hr > 3 {
			t.Errorf("host %q: slot %d:%d out of range", host, hr, min)
		}
	}
}

func TestRescheduleLineKeepsCommandByteIdentical(t *testing.T) {
	line := buildCronLine(7, 3, "/usr/local/bin/clx", "/var/log/50% file.log")
	got, changed := rescheduleLine(line, 37, 3)
	if !changed {
		t.Fatalf("expected reschedule; line = %q", line)
	}
	if !strings.HasPrefix(got, "37 3 * * * ") {
		t.Errorf("schedule not rewritten: %q", got)
	}
	_, rest, ok := splitCronSchedule(line)
	if !ok {
		t.Fatalf("splitCronSchedule failed on %q", line)
	}
	if suffix := strings.TrimPrefix(got, "37 3 * * * "); suffix != rest {
		t.Errorf("command mutated:\n got %q\nwant %q", suffix, rest)
	}
	if _, changed := rescheduleLine(got, 37, 3); changed {
		t.Error("realign is not idempotent")
	}
}

func TestRescheduleLineLeavesForeignLinesAlone(t *testing.T) {
	cases := []string{
		"# clx-managed — auto-update tick.",
		"HOME=/root",
		"CLX_CONFIG_PATH=/home/u/.config/codex-orchestrator/clx.json",
		"*/15 3 * * * root /usr/local/bin/clx --cron run",
		"",
		"7 3 * * 1 root /usr/local/bin/clx --cron run",
	}
	for _, line := range cases {
		if got, changed := rescheduleLine(line, 37, 3); changed {
			t.Errorf("rescheduled %q -> %q", line, got)
		}
	}
}

func TestRescheduleLineRewritesSystemCronUserField(t *testing.T) {
	line := "7 3 * * * root /usr/local/bin/clx --cron run >> '/home/u/.claude/cron.log' 2>&1"
	got, changed := rescheduleLine(line, 37, 3)
	if !changed {
		t.Fatal("expected reschedule")
	}
	want := "37 3 * * * root /usr/local/bin/clx --cron run >> '/home/u/.claude/cron.log' 2>&1"
	if got != want {
		t.Errorf("got %q want %q", got, want)
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
	dest := filepath.Join(dir, "clx")
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

func TestResolveURL(t *testing.T) {
	got := resolveURL("https://orc/", "/wrapper/v2/download")
	if got != "https://orc/wrapper/v2/download" {
		t.Errorf("got %s", got)
	}
}

func minimalCfg(baseURL string) *config.Config {
	return &config.Config{
		SchemaVersion: config.SchemaVersion,
		Engine:        config.EngineClaude,
		Orchestrator: config.Orchestrator{
			BaseURL: baseURL,
			APIKey:  "sk-clx-test-12345",
		},
		Host: config.Host{ID: 1, FQDN: "h.test"},
		Wrapper: config.Wrapper{
			Version:      "dev",
			BinaryURL:    "https://example.invalid/x",
			BinarySHA256: strings.Repeat("a", 64),
		},
	}
}

// stubRealign keeps Tick from reading or rewriting the developer's crontab.
func stubRealign(t *testing.T) {
	t.Helper()
	prev := realignSchedule
	realignSchedule = func() error { return nil }
	t.Cleanup(func() { realignSchedule = prev })
}

func TestTickNoUpdateReportsAndReturns(t *testing.T) {
	stubRealign(t)
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
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
		buf := make([]byte, 4096)
		n, _ := r.Body.Read(buf)
		body := string(buf[:n])
		if !strings.Contains(body, `"engine":"claude"`) {
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

func TestTickWrapperUpdateLoopGuard(t *testing.T) {
	stubRealign(t)
	t.Setenv("CLAUDE_WRAPPER_RESTARTED", "1")
	t.Setenv("CLX_CLAUDE_BIN", "/does/not/exist")
	t.Setenv("PATH", "")

	mux := http.NewServeMux()
	mux.HandleFunc("/cron/check", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "no_update",
			"wrapper": map[string]any{
				"action":         "update",
				"target_version": "9.9.9",
				"sha256":         strings.Repeat("a", 64),
				"url":            "/wrapper/v2/download/clx",
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
