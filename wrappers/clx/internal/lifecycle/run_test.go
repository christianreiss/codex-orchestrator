package lifecycle

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
)

func TestCurrentWrapperVersionPrefersRunningVersion(t *testing.T) {
	cfg := &config.Config{Wrapper: config.Wrapper{Version: "0.6.18"}}
	got := currentWrapperVersion(Options{WrapperVersion: "0.6.23"}, cfg)
	if got != "0.6.23" {
		t.Fatalf("currentWrapperVersion() = %q, want running version", got)
	}
}

func TestCurrentWrapperVersionFallsBackToConfig(t *testing.T) {
	cfg := &config.Config{Wrapper: config.Wrapper{Version: "0.6.18"}}
	got := currentWrapperVersion(Options{}, cfg)
	if got != "0.6.18" {
		t.Fatalf("currentWrapperVersion() = %q, want config version", got)
	}
}

func TestMaybeEnsureClaudeSkipsMatchingTargetWithoutProgressLine(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)

	claudePath := filepath.Join(bin, "claude")
	npmPath := filepath.Join(bin, "npm")
	marker := filepath.Join(dir, "npm-called")
	writeTestScript(t, claudePath, `#!/bin/sh
echo "2.1.168"
`)
	writeTestScript(t, npmPath, `#!/bin/sh
echo called > "`+marker+`"
exit 42
`)
	t.Setenv("CLX_CLAUDE_BIN", claudePath)
	t.Setenv("PATH", bin)

	target := "2.1.168"
	auth := &orchestrator.AuthRetrieveResponse{
		Versions: &orchestrator.VersionSummary{
			AutoUpdateEnabled:         true,
			ClientVersion:             &target,
			ClientVersionEnforceExact: true,
		},
	}

	stderr := captureStderr(t, func() {
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		if got := maybeEnsureClaude(context.Background(), auth, false, logger); got != "" {
			t.Fatalf("maybeEnsureClaude() = %q, want no update", got)
		}
	})
	if strings.Contains(stderr, "installing claude CLI") || strings.Contains(stderr, "claude CLI updated") {
		t.Fatalf("unexpected update progress on stderr: %q", stderr)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("npm was called for an already matching target; stat err=%v", err)
	}
}

func TestNeedsInteractiveAuthRecovery(t *testing.T) {
	cases := []struct {
		name      string
		decision  orchestrator.AuthDecision
		uploadErr error
		want      bool
	}{
		{
			name: "live verification failure",
			decision: orchestrator.AuthDecision{
				Status: "valid",
				Reason: "Claude credentials failed live verification (login expired).",
			},
			want: true,
		},
		{
			name: "missing with upload failure",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "missing",
			},
			uploadErr: errors.New("runner rejected token"),
			want:      true,
		},
		{
			name: "normal valid auth",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "valid",
			},
			want: false,
		},
		{
			name: "disabled host is not a login recovery",
			decision: orchestrator.AuthDecision{
				Status: "disabled",
				Reason: "Auth API disabled by administrator.",
			},
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := needsInteractiveAuthRecovery(tc.decision, tc.uploadErr); got != tc.want {
				t.Fatalf("needsInteractiveAuthRecovery() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestShouldWriteServerAuth(t *testing.T) {
	auth := []byte(`{"claudeAiOauth":{"accessToken":"token"}}`)
	cases := []struct {
		status string
		auth   []byte
		want   bool
	}{
		{"outdated", auth, true},
		{"updated", auth, true},
		{"missing", auth, true},
		{" OUTDATED ", auth, true},
		{"valid", auth, false},
		{"outdated", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.status, func(t *testing.T) {
			if got := shouldWriteServerAuth(tc.status, tc.auth); got != tc.want {
				t.Fatalf("shouldWriteServerAuth(%q, len=%d) = %v, want %v", tc.status, len(tc.auth), got, tc.want)
			}
		})
	}
}

func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	orig := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	defer func() {
		os.Stderr = orig
		_ = r.Close()
	}()

	fn()
	_ = w.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func writeTestScript(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}
