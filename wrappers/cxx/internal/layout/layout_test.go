package layout

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

func TestEnsureAliasesMigratesRegularPersonaBinary(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "cdx")
	wantBytes := []byte("combined-cxx-test-binary")
	if err := os.WriteFile(legacy, wantBytes, 0o755); err != nil {
		t.Fatal(err)
	}
	canonical, err := EnsureAliases(context.Background(), legacy, []string{EngineCodex, EngineClaude})
	if err != nil {
		t.Fatal(err)
	}
	if canonical != filepath.Join(dir, "cxx") {
		t.Fatalf("canonical = %q", canonical)
	}
	got, err := os.ReadFile(canonical)
	if err != nil || !reflect.DeepEqual(got, wantBytes) {
		t.Fatalf("canonical bytes = %q, err=%v", got, err)
	}
	for _, name := range []string{"cdx", "clx"} {
		target, err := os.Readlink(filepath.Join(dir, name))
		if err != nil || target != "cxx" {
			t.Fatalf("%s target=%q err=%v", name, target, err)
		}
	}
}

func TestEnsureAliasesMigratesRegularPersonaOverStaleCXXWithoutSHA(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "clx")
	if err := os.WriteFile(legacy, []byte("running combined bytes"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cxx"), []byte("stale sibling bytes"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureAliases(context.Background(), legacy, []string{EngineClaude}); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(dir, "cxx")); err != nil || string(got) != "running combined bytes" {
		t.Fatalf("canonical bytes=%q err=%v", got, err)
	}
	if target, err := os.Readlink(legacy); err != nil || target != "cxx" {
		t.Fatalf("clx target=%q err=%v", target, err)
	}
}

func TestFirstEngineMigrationReplacesStaleCXXAndBothEnabledAliases(t *testing.T) {
	dir := t.TempDir()
	fresh := []byte("fresh combined binary")
	legacy := filepath.Join(dir, "cdx")
	if err := os.WriteFile(legacy, fresh, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "clx"), []byte("old split claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cxx"), []byte("stale combined binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(fresh)
	if _, err := EnsureAliasesForSHA(context.Background(), legacy, []string{EngineCodex, EngineClaude}, hex.EncodeToString(sum[:])); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "cxx"))
	if err != nil || !reflect.DeepEqual(got, fresh) {
		t.Fatalf("cxx=%q err=%v", got, err)
	}
	for _, alias := range []string{"cdx", "clx"} {
		if target, err := os.Readlink(filepath.Join(dir, alias)); err != nil || target != "cxx" {
			t.Fatalf("%s target=%q err=%v", alias, target, err)
		}
	}
}

func TestExpectedSHAMismatchWithAbsentCXXLeavesLayoutUntouched(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "cdx")
	legacyBytes := []byte("stale split bytes")
	if err := os.WriteFile(legacy, legacyBytes, 0o755); err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256([]byte("different combined artifact"))
	if _, err := EnsureAliasesForSHA(context.Background(), legacy, []string{EngineCodex, EngineClaude}, hex.EncodeToString(want[:])); err == nil {
		t.Fatal("expected sha mismatch")
	}
	if _, err := os.Lstat(filepath.Join(dir, "cxx")); !os.IsNotExist(err) {
		t.Fatalf("cxx unexpectedly created: %v", err)
	}
	if got, err := os.ReadFile(legacy); err != nil || !reflect.DeepEqual(got, legacyBytes) {
		t.Fatalf("legacy changed: %q err=%v", got, err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "clx")); !os.IsNotExist(err) {
		t.Fatalf("clx unexpectedly created: %v", err)
	}
}

func TestDirectStaleCXXDoesNotCreateEnabledAliases(t *testing.T) {
	dir := t.TempDir()
	cxx := filepath.Join(dir, "cxx")
	if err := os.WriteFile(cxx, []byte("stale cxx"), 0o755); err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256([]byte("new signed cxx"))
	if _, err := EnsureAliasesForSHA(context.Background(), cxx, []string{EngineCodex, EngineClaude}, hex.EncodeToString(want[:])); err == nil {
		t.Fatal("expected direct cxx sha mismatch")
	}
	for _, alias := range []string{"cdx", "clx"} {
		if _, err := os.Lstat(filepath.Join(dir, alias)); !os.IsNotExist(err) {
			t.Fatalf("%s unexpectedly created: %v", alias, err)
		}
	}
}

func TestEnsureAliasesDoesNotRemoveOrReplaceUnrequestedEngine(t *testing.T) {
	dir := t.TempDir()
	canonical := filepath.Join(dir, "cxx")
	if err := os.WriteFile(canonical, []byte("cxx"), 0o755); err != nil {
		t.Fatal(err)
	}
	legacyClaude := filepath.Join(dir, "clx")
	if err := os.WriteFile(legacyClaude, []byte("legacy-claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureAliases(context.Background(), canonical, []string{EngineCodex}); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(legacyClaude); err != nil || string(got) != "legacy-claude" {
		t.Fatalf("unrequested clx changed: %q err=%v", got, err)
	}
}

func TestSelectedStartupDoesNotReaddDisabledPeerAlias(t *testing.T) {
	dir := t.TempDir()
	cxx := filepath.Join(dir, "cxx")
	if err := os.WriteFile(cxx, []byte("common"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureAliases(context.Background(), cxx, []string{EngineCodex}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "clx")); !os.IsNotExist(err) {
		t.Fatalf("disabled peer alias was re-added: %v", err)
	}
}

func TestReexecArgvPinsPersonaForCanonicalBinary(t *testing.T) {
	dir := t.TempDir()
	cxx := filepath.Join(dir, "cxx")
	if err := os.WriteFile(cxx, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	got := ReexecArgv(cxx, EngineClaude, []string{"--cron", "run"})
	want := []string{cxx, EngineClaude, "--cron", "run"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("argv=%q want=%q", got, want)
	}
}

func TestLegacyRegularPersonaTargetsNewSiblingCXX(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "cdx")
	if err := os.WriteFile(legacy, []byte("combined"), 0o755); err != nil {
		t.Fatal(err)
	}
	canonical, err := CanonicalExecutable(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(dir, "cxx"); canonical != want {
		t.Fatalf("canonical=%q want=%q", canonical, want)
	}
	if got := ReexecArgv(legacy, EngineCodex, []string{"--version"}); !reflect.DeepEqual(got, []string{legacy, EngineCodex, "--version"}) {
		t.Fatalf("reexec argv=%q", got)
	}
}

func TestRemoveAliasPreservesUnmanagedFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "clx")
	if err := os.WriteFile(path, []byte("legacy"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := RemoveAlias(context.Background(), dir, EngineClaude); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("legacy file removed: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("cxx", path); err != nil {
		t.Fatal(err)
	}
	if err := RemoveAlias(context.Background(), dir, EngineClaude); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("managed alias still exists: %v", err)
	}
}

func TestLayoutLockPathIsTargetStable(t *testing.T) {
	a := lockPathForTarget("/opt/a/cxx")
	if a != lockPathForTarget("/opt/a/cxx") {
		t.Fatal("same canonical target produced different lock paths")
	}
	if a == lockPathForTarget("/opt/b/cxx") {
		t.Fatal("different canonical targets share a lock path")
	}
	if !strings.HasPrefix(filepath.Base(a), lockPrefix) {
		t.Fatalf("lock path=%q", a)
	}
}

func TestLayoutLockWidensRestrictiveUmaskForOtherUIDs(t *testing.T) {
	target := filepath.Join(t.TempDir(), "cxx")
	path := lockPathForTarget(target)
	_ = os.Remove(path)
	t.Cleanup(func() { _ = os.Remove(path) })

	old := syscall.Umask(0o077)
	lock, err := AcquireForTarget(context.Background(), target)
	syscall.Umask(old)
	if err != nil {
		t.Fatal(err)
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o666 {
		t.Fatalf("lock mode=%#o want 0666", got)
	}
}

func TestLayoutLockRejectsSymlink(t *testing.T) {
	target := filepath.Join(t.TempDir(), "cxx")
	path := lockPathForTarget(target)
	_ = os.Remove(path)
	t.Cleanup(func() { _ = os.Remove(path) })
	if err := os.Symlink("/dev/null", path); err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireForTarget(context.Background(), target); err == nil {
		t.Fatal("symlink lock path accepted")
	}
}

func TestLayoutLockRejectsFIFOWithoutBlocking(t *testing.T) {
	target := filepath.Join(t.TempDir(), "cxx")
	path := lockPathForTarget(target)
	_ = os.Remove(path)
	t.Cleanup(func() { _ = os.Remove(path) })
	if err := syscall.Mkfifo(path, 0o666); err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireForTarget(context.Background(), target); err == nil {
		t.Fatal("FIFO lock path accepted")
	}
}

func TestLayoutLockRejectsOwnerOnlyFile(t *testing.T) {
	target := filepath.Join(t.TempDir(), "cxx")
	path := lockPathForTarget(target)
	_ = os.Remove(path)
	t.Cleanup(func() { _ = os.Remove(path) })
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireForTarget(context.Background(), target); err == nil {
		t.Fatal("non-shared lock file accepted")
	}
}

func TestEnsureAliasesRejectsDirectoryCollision(t *testing.T) {
	dir := t.TempDir()
	cxx := filepath.Join(dir, "cxx")
	if err := os.WriteFile(cxx, []byte("common"), 0o755); err != nil {
		t.Fatal(err)
	}
	aliasDir := filepath.Join(dir, "clx")
	if err := os.Mkdir(aliasDir, 0o755); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(aliasDir, "keep")
	if err := os.WriteFile(keep, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureAliases(context.Background(), cxx, []string{EngineClaude}); err == nil {
		t.Fatal("directory alias collision accepted")
	}
	if got, err := os.ReadFile(keep); err != nil || string(got) != "keep" {
		t.Fatalf("directory content changed: %q err=%v", got, err)
	}
}

func TestInstallAtomicRejectsDirectoryDestination(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	dest := filepath.Join(dir, "cxx")
	if err := os.WriteFile(source, []byte("common"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(dest, "keep")
	if err := os.WriteFile(keep, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := InstallAtomic(source, dest); err == nil {
		t.Fatal("directory destination accepted")
	}
	if got, err := os.ReadFile(keep); err != nil || string(got) != "keep" {
		t.Fatalf("directory content changed: %q err=%v", got, err)
	}
}

func TestSudoInstallStagesThenAtomicallyMoves(t *testing.T) {
	old := runSudo
	var calls [][]string
	runSudo = func(args ...string) ([]byte, error) {
		calls = append(calls, append([]string(nil), args...))
		return nil, nil
	}
	t.Cleanup(func() { runSudo = old })
	dest := filepath.Join(t.TempDir(), "cxx")
	if err := sudoInstall("/tmp/source-cxx", dest, syscall.EACCES); err != nil {
		t.Fatal(err)
	}
	if len(calls) < 2 || len(calls[0]) != 5 || calls[0][0] != "install" {
		t.Fatalf("sudo calls=%q", calls)
	}
	staged := calls[0][4]
	if filepath.Dir(staged) != filepath.Dir(dest) || staged == dest {
		t.Fatalf("staging path=%q dest=%q", staged, dest)
	}
	move := calls[1]
	if move[0] != "mv" || move[len(move)-2] != staged || move[len(move)-1] != dest {
		t.Fatalf("move call=%q", move)
	}
}

func TestRemoveSharedDeletesManagedAliasesAndCXXOnly(t *testing.T) {
	dir := t.TempDir()
	cxx := filepath.Join(dir, "cxx")
	if err := os.WriteFile(cxx, []byte("common"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, alias := range []string{"cdx", "clx"} {
		if err := os.Symlink("cxx", filepath.Join(dir, alias)); err != nil {
			t.Fatal(err)
		}
	}
	unmanaged := filepath.Join(dir, "keep")
	if err := os.WriteFile(unmanaged, []byte("keep"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := RemoveShared(context.Background(), cxx); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"cxx", "cdx", "clx"} {
		if _, err := os.Lstat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s still exists: %v", name, err)
		}
	}
	if _, err := os.Stat(unmanaged); err != nil {
		t.Fatalf("unmanaged file removed: %v", err)
	}
}

func TestRemoveSharedDeletesExecutingLegacyRegularCombinedBinary(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "cdx")
	if err := os.WriteFile(legacy, []byte("combined"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := RemoveShared(context.Background(), legacy); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy combined binary remains: %v", err)
	}
}

// TestReexecArgvHostFormOmitsPersonaToken: `cxx update` authenticates through
// one persona but must hand the follow-up sync to the host-level command, which
// reaches every installed engine. An empty engine selects that form.
func TestReexecArgvHostFormOmitsPersonaToken(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "cxx")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	host := ReexecArgv(exe, "", []string{"sync", "--config", "/etc/cdx.json"})
	if !reflect.DeepEqual(host, []string{exe, "sync", "--config", "/etc/cdx.json"}) {
		t.Fatalf("host form = %v, want no persona token", host)
	}

	persona := ReexecArgv(exe, EngineCodex, []string{"sync"})
	if !reflect.DeepEqual(persona, []string{exe, EngineCodex, "sync"}) {
		t.Fatalf("persona form = %v, want the engine token preserved", persona)
	}
}
