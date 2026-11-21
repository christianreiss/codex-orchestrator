package enginestore

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

func TestUninstallRemovesOnlySelectedPrivateStore(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	engines := filepath.Join(home, ".cxx", "engines")
	root := filepath.Join(engines, "kimi")
	other := filepath.Join(engines, "grok")
	seed(t, root, "2.7.2")
	seed(t, other, "1.2.3")
	if err := os.Symlink(other, filepath.Join(root, "linked-prefix")); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := Uninstall(t.Context(), root, testLock); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Lstat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("removed store: %v", err)
	}
	if _, err := os.Stat(filepath.Join(other, "1.2.3", "node_modules")); err != nil {
		t.Fatalf("sibling store: %v", err)
	}
}

func TestUninstallRejectsRedirectedOrMalformedStorePaths(t *testing.T) {
	for _, target := range []string{".cxx", ".cxx/engines", ".cxx/engines/kimi", ".cxx/engines/kimi/install.lock"} {
		t.Run(target, func(t *testing.T) {
			home, other := t.TempDir(), t.TempDir()
			t.Setenv("HOME", home)
			marker := filepath.Join(other, "user-file")
			if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(home, target)
			if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(other, link); err != nil {
				t.Fatal(err)
			}
			if err := Uninstall(t.Context(), filepath.Join(home, ".cxx", "engines", "kimi"), testLock); err == nil {
				t.Fatal("uninstall accepted a redirected path")
			}
			if _, err := os.Lstat(link); err != nil {
				t.Fatalf("unexpected entry removed: %v", err)
			}
			if _, err := os.Stat(marker); err != nil {
				t.Fatalf("linked user directory changed: %v", err)
			}
		})
	}
}

func TestUninstallPreservesInstallerAndRunningVersion(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, ".cxx", "engines", "grok")
	seed(t, root, "1.2.3")
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(root, testLock))
	if err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(t.Context(), root, testLock); !errors.Is(err, ipc.ErrHeld) {
		t.Fatalf("expected held installer lock: %v", err)
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
	path, err := exec.LookPath("cat")
	if err != nil {
		t.Fatal(err)
	}
	bin, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(root, "1.2.3", "grok")
	if err := os.WriteFile(cli, bin, 0o700); err != nil {
		t.Fatal(err)
	}
	cli, err = filepath.EvalSymlinks(cli)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(t.Context(), cli)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stdin.Close(); _ = cmd.Wait() }()
	if err := Uninstall(t.Context(), root, testLock); err == nil {
		t.Fatal("uninstall accepted a running version")
	}
	if _, err := os.Stat(cli); err != nil {
		t.Fatalf("running private CLI removed: %v", err)
	}
}
