package codex

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// TestDoctorOutputGolden pins the complete `cdx doctor --minimal` report. The
// shared checks live in launcherdoctor; this proves their rows, wording and
// order stay byte-identical. Host-dependent values (time, temp paths, latency,
// free space, cron placement, platform) are normalised. Regenerate with
// CXX_UPDATE_GOLDEN=1 only for an intended output change.
func TestDoctorOutputGolden(t *testing.T) {
	home := t.TempDir()
	bin := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	t.Setenv("PATH", bin)
	t.Setenv("COLUMNS", "1000")
	t.Setenv("SSH_TTY", "")
	t.Setenv("SSH_CONNECTION", "")
	t.Setenv("TERM", "xterm-golden")
	t.Setenv("TERM_PROGRAM", "")
	cli := filepath.Join(bin, "codex")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\necho 'codex-cli 0.99.1'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", cli)
	// An empty user crontab: the Cron row then prints the engine's install hint.
	if err := os.WriteFile(filepath.Join(bin, "crontab"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "config.toml"), []byte("model = \"gpt\"\n[mcp_servers.cdx]\ncommand = \"cdx\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "auth.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/auth" {
			_, _ = w.Write([]byte(`{"status":"outdated"}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	var out bytes.Buffer
	err := Doctor(context.Background(), doctorConfig(server.URL), &out, "1.2.3", true)
	if err == nil || err.Error() != "1 doctor checks failed" {
		t.Fatalf("doctor verdict = %v", err)
	}
	got := normalizeDoctorGolden(t, out.String(), map[string]string{home: "<home>", bin: "<bin>", server.URL: "<api>"})
	checkDoctorGolden(t, filepath.Join("testdata", "doctor_golden.txt"), got)
}

func normalizeDoctorGolden(t *testing.T, text string, paths map[string]string) string {
	t.Helper()
	exe, _ := os.Executable()
	text = strings.ReplaceAll(text, exe, "<exe>")
	for path, label := range paths {
		text = strings.ReplaceAll(text, path, label)
	}
	text = strings.ReplaceAll(text, runtime.GOOS+"/"+runtime.GOARCH, "<os>/<arch>")
	text = regexp.MustCompile(`DOCTOR \| \d{4}-\d\d-\d\d \d\d:\d\d`).ReplaceAllString(text, "DOCTOR | <when>")
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		switch {
		case strings.Contains(line, " DISK "):
			if !strings.HasPrefix(line, "OK ") {
				t.Skipf("temp filesystem is short on space, so the Disk row changes the verdict: %s", line)
			}
			lines[i] = regexp.MustCompile(`\d+MB free`).ReplaceAllString(line, "<n>MB free")
		case strings.Contains(line, " LATENCY "):
			lines[i] = regexp.MustCompile(`\| \S+$`).ReplaceAllString(line, "| <latency>")
		case strings.Contains(line, " CRON "):
			// System cron placement depends on the test host. Without it the
			// fake empty crontab must yield the engine's install hint.
			if line != "OK   CRON      | installed (system /etc/cron.d/cxx-managed)" && line != "WARN CRON      | not installed (run `cdx cron install`)" {
				t.Fatalf("unexpected cron row: %s", line)
			}
			lines[i] = "<cron row>"
		}
	}
	return strings.Join(lines, "\n")
}

func checkDoctorGolden(t *testing.T, path, got string) {
	t.Helper()
	if os.Getenv("CXX_UPDATE_GOLDEN") == "1" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Fatalf("doctor output changed\n--- got\n%s\n--- want\n%s", got, want)
	}
}
