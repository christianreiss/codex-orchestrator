package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func TestMissingLocalAuthFileNeedsRecovery(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	missing := fmt.Errorf("read auth: %w", &fs.PathError{Op: "open", Path: "auth.json", Err: fs.ErrNotExist})
	for _, status := range []string{"missing", "upload_required"} {
		dec := orchestrator.AuthDecision{Allowed: true, Status: status}
		if !needsInteractiveAuthRecovery(dec, missing, true) {
			t.Fatalf("%s + missing auth.json did not ask for recovery", status)
		}
		if got := recoveryReason(dec, missing); strings.Contains(got, "not accepted") {
			t.Fatalf("missing file reads as a server rejection: %q", got)
		}
	}
	if needsInteractiveAuthRecovery(orchestrator.AuthDecision{Allowed: true, Status: "valid"}, missing, true) {
		t.Fatal("a valid fleet credential must not trigger recovery")
	}
}

// fakeCodexLogin installs a Codex CLI whose only effect is a marker file, so a
// test can prove whether `codex login` was started.
func fakeCodexLogin(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	marker := filepath.Join(dir, "login-started")
	bin := filepath.Join(dir, "codex")
	script := "#!/bin/sh\nif [ \"$1\" = login ]; then touch \"" + marker + "\"; exit 3; fi\nprintf '0.144.1\\n'\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", bin)
	return marker
}

func stubCodexRecoveryTerminal(t *testing.T, terminal bool, answer string) {
	t.Helper()
	previousTerminal, previousIn := lifecycleIsTerminal, promptIn
	lifecycleIsTerminal = func(int) bool { return terminal }
	promptIn = strings.NewReader(answer)
	t.Cleanup(func() { lifecycleIsTerminal, promptIn = previousTerminal, previousIn })
}

func captureCodexStderr(t *testing.T, fn func()) string {
	t.Helper()
	orig := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	done := make(chan string, 1)
	go func() {
		out, _ := io.ReadAll(r)
		done <- string(out)
	}()
	defer func() { os.Stderr = orig }()
	fn()
	_ = w.Close()
	return <-done
}

func TestRecoverCodexAuthConfirmsBeforeLogin(t *testing.T) {
	for _, tc := range []struct {
		name      string
		terminal  bool
		answer    string
		wantLogin bool
		wantErr   error
	}{
		{name: "no terminal", terminal: false, wantErr: errAuthRecoveryNonInteractive},
		{name: "declined", terminal: true, answer: "n\n", wantErr: errAuthRecoveryDeclined},
		{name: "enter accepts", terminal: true, answer: "\n", wantLogin: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CODEX_HOME", t.TempDir())
			marker := fakeCodexLogin(t)
			stubCodexRecoveryTerminal(t, tc.terminal, tc.answer)
			var err error
			stderr := captureCodexStderr(t, func() {
				err = recoverCodexAuth(context.Background(), &config.Config{}, nil, "No Codex credentials exist on this host or the orchestrator.")
			})
			if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
				t.Fatalf("recoverCodexAuth() = %v, want %v", err, tc.wantErr)
			}
			_, statErr := os.Stat(marker)
			if started := statErr == nil; started != tc.wantLogin {
				t.Fatalf("codex login started=%v, want %v (err=%v)", started, tc.wantLogin, err)
			}
			if tc.wantLogin && (err == nil || !strings.Contains(err.Error(), "codex login exited with status 3")) {
				t.Fatalf("login exit not surfaced: %v", err)
			}
			if tc.terminal && !strings.Contains(stderr, "Run `codex login` now? [Y/n]") {
				t.Fatalf("recovery prompt = %q", stderr)
			}
			if !tc.terminal && stderr != "" {
				t.Fatalf("non-interactive recovery printed a prompt: %q", stderr)
			}
		})
	}
}

// TestSyncWithoutAnyCredentialsWarnsAndNeverLogsIn is the installer case:
// `cdx sync </dev/null` on a fresh host where neither the host nor the fleet
// has Codex credentials. It must not prompt or start `codex login`; it names
// the command once and still reports the managed sync as done.
func TestSyncWithoutAnyCredentialsWarnsAndNeverLogsIn(t *testing.T) {
	for _, headless := range []bool{true, false} {
		t.Run(fmt.Sprintf("headless=%v", headless), func(t *testing.T) {
			cfg, home := syncOnlyHost(t, "")
			if err := os.Remove(filepath.Join(home, ".codex", "auth.json")); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/skills" {
					_, _ = io.WriteString(w, `{"skills":[]}`)
					return
				}
				_, _ = io.WriteString(w, `{"status":"ok","agents":"# fleet\n","config":"model = \"fleet\"\n","auth":{"status":"missing","host":{"secure":true}}}`)
			}))
			defer server.Close()
			cfg.Orchestrator.BaseURL = server.URL
			cfg.Host.Secure = true
			marker := fakeCodexLogin(t)
			stubCodexRecoveryTerminal(t, false, "")
			var (
				exit int
				err  error
			)
			stderr := captureCodexStderr(t, func() {
				exit, err = Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: headless, SkipBoot: true, Logger: slog.New(slog.DiscardHandler)})
			})
			if exit != 0 || err != nil {
				t.Fatalf("Run() = %d, %v; stderr=%q", exit, err, stderr)
			}
			if strings.Count(stderr, "run `cdx login`") != 1 {
				t.Fatalf("missing-credentials notice = %q", stderr)
			}
			if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
				t.Fatalf("unattended sync started codex login: %v", statErr)
			}
		})
	}
}
