package claude

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestEnsureClaudeFailsWhenNpmMissing(t *testing.T) {
	// PATH=empty guarantees no npm is found.
	t.Setenv("PATH", "")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := EnsureClaude(context.Background(), "1.0.40", true, logger)
	if err == nil {
		t.Fatal("expected error when npm missing")
	}
	if !errors.Is(err, err) || err.Error() == "" {
		t.Errorf("err=%v", err)
	}
}

func TestEnsureClaudeSkipsAlreadyMatchingExactTarget(t *testing.T) {
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

	claudePath := filepath.Join(bin, scriptName("claude"))
	npmPath := filepath.Join(bin, scriptName("npm"))
	marker := filepath.Join(dir, "npm-called")
	writeScript(t, claudePath, `#!/bin/sh
echo "2.1.168"
`)
	writeScript(t, npmPath, `#!/bin/sh
echo called > "`+marker+`"
exit 42
`)
	t.Setenv("CLX_CLAUDE_BIN", claudePath)
	t.Setenv("PATH", bin)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := EnsureClaude(context.Background(), "2.1.168", true, logger); err != nil {
		t.Fatalf("EnsureClaude: %v", err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("npm was called for an already matching target; stat err=%v", err)
	}
}

func TestIsPermErr(t *testing.T) {
	cases := []struct {
		name string
		out  string
		err  error
		want bool
	}{
		{"eacces", "npm WARN EACCES /usr/local", errors.New("exit 1"), true},
		{"permission_denied", "permission denied", errors.New("exit 1"), true},
		{"network", "ETIMEDOUT", errors.New("exit 1"), false},
		{"no_err", "anything", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isPermErr([]byte(tc.out), tc.err); got != tc.want {
				t.Errorf("got %v want %v", got, tc.want)
			}
		})
	}
}

func scriptName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".bat"
	}
	return name
}

func writeScript(t *testing.T, path, body string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		body = "@echo off\r\n" + body
	}
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}
