package update

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestUpdateStageDirsPreferInstallDirAndKeepTempLast(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dest := filepath.Join(t.TempDir(), "bin", "cxx")
	dirs := updateStageDirs(dest)
	if len(dirs) != 3 {
		t.Fatalf("stage dirs = %+v", dirs)
	}
	if dirs[0].path != filepath.Dir(dest) || dirs[0].create {
		t.Fatalf("first stage dir = %+v, want install dir without creation", dirs[0])
	}
	if dirs[1].path != filepath.Join(home, ".cxx", "staging") || !dirs[1].create {
		t.Fatalf("second stage dir = %+v, want private staging dir", dirs[1])
	}
	if dirs[2].path != os.TempDir() {
		t.Fatalf("last stage dir = %+v, want os.TempDir()", dirs[2])
	}
}

func TestCreateStageFileSkipsMissingDirAndCreatesPrivateStaging(t *testing.T) {
	root := t.TempDir()
	staging := filepath.Join(root, "home", ".cxx", "staging")
	dirs := []stageDir{{path: filepath.Join(root, "missing-install-dir")}, {path: staging, create: true}}
	f, idx, err := createStageFile(dirs)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	_ = f.Close()
	if idx != 1 || filepath.Dir(f.Name()) != staging {
		t.Fatalf("staged at %s (index %d), want %s", f.Name(), idx, staging)
	}
	info, err := os.Stat(staging)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("staging mode = %v, want 0700", info.Mode().Perm())
	}
	if _, err := os.Stat(filepath.Join(root, "missing-install-dir")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("install dir must never be created, stat err = %v", err)
	}
}

// A noexec mount makes execve fail with EACCES; the check must move the
// verified bytes to the next candidate instead of failing the update.
func TestVerifyStagedExecutableFallsBackFromNoexecDir(t *testing.T) {
	noexec := t.TempDir()
	execOK := t.TempDir()
	path := filepath.Join(noexec, ".cxx-wrapper-1.new")
	if err := os.WriteFile(path, []byte("verified bytes"), 0o755); err != nil {
		t.Fatal(err)
	}
	var tried []string
	restore := runVersionCheck
	runVersionCheck = func(_ context.Context, p string) error {
		tried = append(tried, p)
		if strings.HasPrefix(p, noexec+string(os.PathSeparator)) {
			return fmt.Errorf("new cxx failed --version sanity check: %w", &fs.PathError{Op: "fork/exec", Path: p, Err: syscall.EACCES})
		}
		return nil
	}
	t.Cleanup(func() { runVersionCheck = restore })

	got, cleanup, err := verifyStagedExecutable(context.Background(), path, []stageDir{{path: execOK}})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(got) != execOK || len(tried) != 2 {
		t.Fatalf("checked %v, returned %s", tried, got)
	}
	data, err := os.ReadFile(got)
	if err != nil || string(data) != "verified bytes" {
		t.Fatalf("fallback copy = %q, %v", data, err)
	}
	if info, _ := os.Stat(got); info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("fallback copy not executable: %v", info.Mode())
	}
	cleanup()
	if _, err := os.Stat(got); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cleanup left fallback copy: %v", err)
	}
}

func TestVerifyStagedExecutableDoesNotMaskRealFailures(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".cxx-wrapper-1.new")
	if err := os.WriteFile(path, []byte("bad"), 0o755); err != nil {
		t.Fatal(err)
	}
	restore := runVersionCheck
	calls := 0
	runVersionCheck = func(context.Context, string) error {
		calls++
		return errors.New("new cxx failed --version sanity check: exit status 2")
	}
	t.Cleanup(func() { runVersionCheck = restore })
	_, cleanup, err := verifyStagedExecutable(context.Background(), path, []stageDir{{path: t.TempDir()}})
	defer cleanup()
	if err == nil || calls != 1 {
		t.Fatalf("err = %v, calls = %d; a broken binary must fail without fallback", err, calls)
	}
}

func TestVerifyExecutableRunsRealBinary(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".cxx-wrapper-1.new")
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho cxx 0.0.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, cleanup, err := verifyStagedExecutable(context.Background(), path, nil)
	defer cleanup()
	if err != nil || got != path {
		t.Fatalf("got %s, %v", got, err)
	}
}
