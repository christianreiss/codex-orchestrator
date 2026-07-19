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

func TestEnsureClaudeCachesNpmPrefixWhenPathHasStaleShadow(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only")
	}
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	staleBin := filepath.Join(dir, "stale-bin")
	npmBin := filepath.Join(dir, "npm-bin")
	prefix := filepath.Join(dir, "prefix")
	root := filepath.Join(prefix, "lib", "node_modules")
	for _, path := range []string{home, staleBin, npmBin, filepath.Join(prefix, "bin"), filepath.Join(root, "@anthropic-ai", "claude-code", "bin")} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)

	writeScript(t, filepath.Join(staleBin, "claude"), `#!/bin/sh
echo "2.1.179 (Claude Code)"
`)
	writeScript(t, filepath.Join(prefix, "bin", "claude"), `#!/bin/sh
echo "2.1.204 (Claude Code)"
`)
	writeScript(t, filepath.Join(npmBin, "npm"), `#!/bin/sh
if [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then
  echo "`+prefix+`"
  exit 0
fi
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then
  echo "`+root+`"
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "-g" ]; then
  exit 0
fi
echo "unexpected npm args: $*" >&2
exit 2
`)
	t.Setenv("PATH", staleBin+string(os.PathListSeparator)+npmBin+string(os.PathListSeparator)+"/bin")
	if err := cacheClaude(filepath.Join(staleBin, "claude")); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := EnsureClaude(context.Background(), "2.1.204", true, logger); err != nil {
		t.Fatalf("EnsureClaude: %v", err)
	}
	cached := cachedClaudeBin()
	want := filepath.Join(prefix, "bin", "claude")
	if cached != want {
		t.Fatalf("cachedClaudeBin() = %q, want %q", cached, want)
	}
	if got := Version(context.Background()); got != "2.1.204" {
		t.Fatalf("Version() = %q, want 2.1.204", got)
	}
}

func TestEnsureClaudeRecoversSkippedPostinstall(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only")
	}
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	staleBin := filepath.Join(dir, "stale-bin")
	npmBin := filepath.Join(dir, "npm-bin")
	prefix := filepath.Join(dir, "prefix")
	root := filepath.Join(prefix, "lib", "node_modules")
	packageDir := filepath.Join(root, "@anthropic-ai", "claude-code")
	for _, path := range []string{home, staleBin, npmBin, filepath.Join(prefix, "bin"), packageDir} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)

	writeScript(t, filepath.Join(staleBin, "claude"), "#!/bin/sh\necho '2.1.161 (Claude Code)'\n")
	candidate := filepath.Join(prefix, "bin", "claude")
	if err := os.WriteFile(candidate, []byte("#!/bin/sh\necho '2.1.215 (Claude Code)'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "install.cjs"), []byte("// fixture\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dir, "postinstall-called")
	writeScript(t, filepath.Join(npmBin, "npm"), `#!/bin/sh
if [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then
  echo "`+prefix+`"
  exit 0
fi
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then
  echo "`+root+`"
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "-g" ]; then
  exit 0
fi
echo "unexpected npm args: $*" >&2
exit 2
`)
	writeScript(t, filepath.Join(npmBin, "node"), `#!/bin/sh
test "$1" = "`+filepath.Join(packageDir, "install.cjs")+`" || exit 2
chmod +x "$TEST_CLAUDE_CANDIDATE"
: > "$TEST_POSTINSTALL_MARKER"
`)
	t.Setenv("TEST_CLAUDE_CANDIDATE", candidate)
	t.Setenv("TEST_POSTINSTALL_MARKER", marker)
	t.Setenv("PATH", staleBin+string(os.PathListSeparator)+npmBin+string(os.PathListSeparator)+"/bin")
	if err := cacheClaude(filepath.Join(staleBin, "claude")); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := EnsureClaude(context.Background(), "2.1.215", true, logger); err != nil {
		t.Fatalf("EnsureClaude: %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("postinstall was not called: %v", err)
	}
	if got := cachedClaudeBin(); got != candidate {
		t.Fatalf("cachedClaudeBin() = %q, want %q", got, candidate)
	}
	if got := Version(context.Background()); got != "2.1.215" {
		t.Fatalf("Version() = %q, want 2.1.215", got)
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
