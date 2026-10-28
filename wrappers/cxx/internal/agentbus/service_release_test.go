package agentbus

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/buildinfo"
)

func stubBuildVersion(t *testing.T, version string) {
	t.Helper()
	old := buildinfo.Version
	t.Cleanup(func() { buildinfo.Version = old })
	buildinfo.Version = version
}

// Feedback 3e2df8d1: a `go build` of clx in a scratch directory ran the
// automatic service ensure and rewrote the user's shared cxx-agent.service so
// ExecStart pointed at the throwaway binary. A development build must leave the
// unit alone; the release build and an explicit operator install keep working.
func TestAutomaticServiceEnsureLeavesUnitAloneForDevelopmentBuild(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd action is Linux-specific")
	}
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg"))
	calls := stubServiceProcess(t, nil)
	stubLinger(t, "relayuser", false)
	stubWorkerPolicy(t, workerAllowed)
	path, err := servicePath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	installed := []byte("[Service]\nExecStart=\"/usr/local/bin/cxx\" agent worker --foreground\n")
	if err := os.WriteFile(path, installed, 0o600); err != nil {
		t.Fatal(err)
	}

	stubBuildVersion(t, "dev")
	var note bytes.Buffer
	if err := EnsureService(io.Discard, &note); err != nil {
		t.Fatalf("development build ensure: %v", err)
	}
	if got, _ := os.ReadFile(path); !bytes.Equal(got, installed) || len(*calls) != 0 {
		t.Fatalf("development build repointed the shared unit: calls=%v unit=%q", *calls, got)
	}
	if !strings.Contains(note.String(), "development build") || !strings.Contains(note.String(), "cxx agent service install") {
		t.Fatalf("skip was silent or unexplained: %q", note.String())
	}

	// An explicit operator install from the same build is a decision, not an accident.
	if err := runServiceCommand([]string{"install"}, io.Discard, io.Discard); err != nil {
		t.Fatalf("explicit install from a development build: %v", err)
	}
	if got, _ := os.ReadFile(path); bytes.Equal(got, installed) || len(*calls) == 0 {
		t.Fatalf("explicit install was refused: calls=%v", *calls)
	}

	if err := os.WriteFile(path, installed, 0o600); err != nil {
		t.Fatal(err)
	}
	*calls = nil
	stubBuildVersion(t, "0.9.142")
	if err := EnsureService(io.Discard, io.Discard); err != nil {
		t.Fatalf("release ensure: %v", err)
	}
	if got, _ := os.ReadFile(path); bytes.Equal(got, installed) || len(*calls) == 0 {
		t.Fatalf("release build no longer maintains its unit: calls=%v", *calls)
	}
}

// Retirement is a change to the shared unit as well; a development build on a
// non-persistent host must not remove the installed binary's unit either.
func TestAutomaticServiceEnsureDoesNotRetireUnitForDevelopmentBuild(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd action is Linux-specific")
	}
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg"))
	calls := stubServiceProcess(t, nil)
	stubWorkerPolicy(t, workerForbidden)
	stubUserManager(t, true)
	stubBuildVersion(t, "dev")
	path, err := servicePath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("unit"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureService(io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) || len(*calls) != 0 {
		t.Fatalf("development build retired the shared unit: calls=%v err=%v", *calls, err)
	}
}
