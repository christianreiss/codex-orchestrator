package enginestore

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

const testLock = "install.lock"

func seed(t *testing.T, root string, versions ...string) {
	t.Helper()
	for _, v := range versions {
		if err := os.MkdirAll(filepath.Join(root, v, "node_modules"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPruneKeepsOnlyThePublishedVersion(t *testing.T) {
	root := t.TempDir()
	seed(t, root, "1.0.0-aaa", "1.0.1-bbb", "1.0.2-ccc")
	cli := filepath.Join(root, "1.0.2-ccc", "node_modules", "claude")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	removed, err := PruneEngine(root, cli, testLock, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 2 {
		t.Fatalf("expected two superseded prefixes removed, got %v", removed)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() && entry.Name() != "1.0.2-ccc" {
			t.Fatalf("stale prefix survived: %s", entry.Name())
		}
	}
	if _, err := os.Stat(filepath.Join(root, "1.0.2-ccc")); err != nil {
		t.Fatalf("published prefix was removed: %v", err)
	}
}

// An abandoned stage from an interrupted install is indistinguishable from a
// published prefix by name, and the same rule must reclaim it.
func TestPruneRemovesAbandonedInstallStages(t *testing.T) {
	root := t.TempDir()
	seed(t, root, "2.0.0-live", "2.0.0-halfdone")
	cli := filepath.Join(root, "2.0.0-live", "codex")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	removed, err := PruneEngine(root, cli, testLock, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 1 || removed[0] != "2.0.0-halfdone" {
		t.Fatalf("expected the abandoned stage removed, got %v", removed)
	}
}

// A pointer we cannot vouch for must never become a wipe of the whole store.
func TestPruneWithoutAResolvedPointerIsANoOp(t *testing.T) {
	root := t.TempDir()
	seed(t, root, "3.0.0-aaa", "3.0.1-bbb")
	for _, cli := range []string{"", filepath.Join(t.TempDir(), "elsewhere", "claude")} {
		removed, err := PruneEngine(root, cli, testLock, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(removed) != 0 {
			t.Fatalf("swept the store without a usable pointer: %v", removed)
		}
	}
	if entries, err := os.ReadDir(root); err != nil || len(entries) != 2 {
		t.Fatalf("expected both prefixes intact, got %v (%v)", entries, err)
	}
}

// The installer holds this lock across its whole staged install, during which
// the stage has no engine process running from it and the in-use check is
// blind. A held lock must stop the sweep outright.
func TestPruneSkipsWhileAnInstallerHoldsTheLock(t *testing.T) {
	root := t.TempDir()
	seed(t, root, "4.0.0-live", "4.0.0-staging")
	cli := filepath.Join(root, "4.0.0-live", "codex")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	held, err := ipc.TryAcquireExclusivePath(filepath.Join(root, testLock))
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	removed, err := PruneEngine(root, cli, testLock, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 0 {
		t.Fatalf("swept under a running installer: %v", removed)
	}
	if _, err := os.Stat(filepath.Join(root, "4.0.0-staging")); err != nil {
		t.Fatalf("deleted a stage mid-install: %v", err)
	}
}

// The lock files live in the same root as the version directories.
func TestPruneLeavesPlainFilesAlone(t *testing.T) {
	root := t.TempDir()
	seed(t, root, "5.0.0-live")
	lock := filepath.Join(root, testLock)
	if err := os.WriteFile(lock, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(root, "5.0.0-live", "codex")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := PruneEngine(root, cli, testLock, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(lock); err != nil {
		t.Fatalf("removed the install lock: %v", err)
	}
}

func TestPruneOnAMissingRootIsANoOp(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	removed, err := Prune(root, "1.0.0-aaa", testLock, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 0 {
		t.Fatalf("reported removals from a missing root: %v", removed)
	}
}

// A prefix a live process runs from is never reclaimed. The running test binary
// is the one process this test can be sure about.
func TestInUseTracksTheRunningProcess(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skip("no executable path on this platform")
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		t.Skip("cannot resolve the test binary")
	}
	if !inUse(filepath.Dir(resolved)) {
		t.Fatalf("the directory holding the running test binary reported idle: %s", filepath.Dir(resolved))
	}
	if inUse(t.TempDir()) {
		t.Fatal("an empty directory nothing runs from reported busy")
	}
}
