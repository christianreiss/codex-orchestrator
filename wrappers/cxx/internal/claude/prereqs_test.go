package claude

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPackageNamesForKnownCombinations(t *testing.T) {
	cases := []struct {
		tool, kind string
		want       []string
	}{
		{"apt-get", "node", []string{"nodejs"}},
		{"apt-get", "npm", []string{"npm"}},
		{"dnf", "node", []string{"nodejs"}},
		{"apk", "npm", []string{"npm"}},
		{"brew", "node", []string{"node"}},
		{"brew", "npm", []string{"node"}},
	}
	for _, tc := range cases {
		got, err := packageNamesFor(tc.tool, tc.kind)
		if err != nil {
			t.Errorf("%s:%s: %v", tc.tool, tc.kind, err)
			continue
		}
		if len(got) != len(tc.want) || got[0] != tc.want[0] {
			t.Errorf("%s:%s: got %v want %v", tc.tool, tc.kind, got, tc.want)
		}
	}
	if _, err := packageNamesFor("unknown-tool", "node"); err == nil {
		t.Error("expected error for unmapped package manager")
	}
}

func TestDetectPackageManagerFindsFirstOnPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only")
	}
	dir := t.TempDir()
	writeScript(t, filepath.Join(dir, "dnf"), "#!/bin/sh\nexit 0\n")
	t.Setenv("PATH", dir)

	tool, err := detectPackageManager()
	if err != nil {
		t.Fatalf("detectPackageManager: %v", err)
	}
	if tool != "dnf" {
		t.Fatalf("tool=%q want dnf", tool)
	}
}

func TestDetectPackageManagerFailsWhenNoneOnPath(t *testing.T) {
	t.Setenv("PATH", "")
	if _, err := detectPackageManager(); err == nil {
		t.Fatal("expected error when no package manager is on PATH")
	}
}

// installOSPackage must reach the detected manager with the right package
// names regardless of whether the process is root (direct invocation) or
// not (sudo -n escalation) — self-contained sudo/env stubs make the test
// deterministic in both cases instead of depending on real system binaries.
func TestInstallOSPackageInvokesDetectedManager(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "apt-get.log")
	writeScript(t, filepath.Join(dir, "apt-get"), `#!/bin/sh
echo "$@" >> "`+logPath+`"
exit 0
`)
	writeScript(t, filepath.Join(dir, "sudo"), `#!/bin/sh
shift
exec "$@"
`)
	writeScript(t, filepath.Join(dir, "env"), `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    *=*) eval "export '$1'"; shift ;;
    *) break ;;
  esac
done
exec "$@"
`)
	t.Setenv("PATH", dir)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := installOSPackage(context.Background(), "node", logger); err != nil {
		t.Fatalf("installOSPackage: %v", err)
	}
	out, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read apt-get log: %v", err)
	}
	if !strings.Contains(string(out), "install -y --no-install-recommends nodejs") {
		t.Fatalf("unexpected apt-get invocation: %q", out)
	}
}

func TestEnsurePrerequisitesNoopWhenNodeAndNpmPresent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only")
	}
	dir := t.TempDir()
	writeScript(t, filepath.Join(dir, "node"), "#!/bin/sh\nexit 0\n")
	writeScript(t, filepath.Join(dir, "npm"), "#!/bin/sh\nexit 0\n")
	t.Setenv("PATH", dir)

	if err := ensurePrerequisites(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatalf("ensurePrerequisites: %v", err)
	}
}

func TestEnsurePrerequisitesFailsClosedWithoutPackageManager(t *testing.T) {
	t.Setenv("PATH", "")
	if err := ensurePrerequisites(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil {
		t.Fatal("expected error when neither npm nor a package manager is available")
	}
}
