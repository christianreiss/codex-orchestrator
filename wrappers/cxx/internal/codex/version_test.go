package codex

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestMain(m *testing.M) {
	if marker := os.Getenv("CXX_TEST_NATIVE_VERSION"); marker != "" && len(os.Args) == 2 && (os.Args[1] == "-V" || os.Args[1] == "--version") {
		f, err := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			os.Exit(2)
		}
		_, _ = f.WriteString("probe\n")
		_ = f.Close()
		time.Sleep(40 * time.Millisecond)
		if os.Getenv("CXX_TEST_VERSION_FAIL") == "1" {
			os.Exit(1)
		}
		_, _ = os.Stdout.WriteString("codex-cli 0.166.0\n")
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func nativeVersionFixture(t *testing.T) (string, string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	bin, probes := filepath.Join(dir, "codex"), filepath.Join(dir, "probes")
	if err := os.WriteFile(bin, raw, 0700); err != nil {
		t.Fatal(err)
	}
	if !nativeVersionFile(bin) {
		t.Skip("native version reuse requires ELF or Mach-O")
	}
	t.Setenv("CDX_CODEX_BIN", bin)
	t.Setenv("CXX_TEST_NATIVE_VERSION", probes)
	return bin, probes
}

func probeCount(t *testing.T, path string) int {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(raw), "probe\n")
}

func TestNativeVersionReuseAcrossBootModelCheckAndFooter(t *testing.T) {
	bin, probes := nativeVersionFixture(t)
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("model='gpt-6.1-terra'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if got := Version(context.Background()); got != "0.166.0" {
		t.Fatal(got)
	}
	first := time.Since(started)
	if err := CheckModelSupport(context.Background(), &config.Config{Engine: "codex"}, []string{"exec", "prompt"}); err != nil {
		t.Fatal(err)
	}
	if got := Version(context.Background()); got != "0.166.0" {
		t.Fatal(got)
	}
	if count := probeCount(t, probes); count != 1 {
		t.Fatalf("boot/model/footer executed %d probes, want one", count)
	}
	reused := time.Since(started)
	baseline := time.Now()
	for range 3 {
		if err := exec.Command(bin, "-V").Run(); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("boot/model/footer: uncached %s, reused %s (first probe %s); subprocesses 3 -> 1", time.Since(baseline), reused, first)
}

func TestNativeVersionReprobesChangedBinary(t *testing.T) {
	bin, probes := nativeVersionFixture(t)
	_ = Version(context.Background())
	info, err := os.Stat(bin)
	if err != nil {
		t.Fatal(err)
	}
	// A replacement with matching size and mtime must still invalidate by inode.
	raw, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	replacement := bin + ".replacement"
	if err := os.WriteFile(replacement, raw, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(replacement, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, bin); err != nil {
		t.Fatal(err)
	}
	_ = Version(context.Background())
	changed := info.ModTime().Add(time.Second)
	if err := os.Chtimes(bin, changed, changed); err != nil {
		t.Fatal(err)
	}
	_ = Version(context.Background())
	if count := probeCount(t, probes); count != 3 {
		t.Fatalf("binary replacement/change executed %d probes, want three", count)
	}
}

func TestNativeVersionDoesNotCacheFailureOrIgnoreCancellation(t *testing.T) {
	_, probes := nativeVersionFixture(t)
	t.Setenv("CXX_TEST_VERSION_FAIL", "1")
	if got := Version(context.Background()); got != "unknown" {
		t.Fatal(got)
	}
	t.Setenv("CXX_TEST_VERSION_FAIL", "0")
	if got := Version(context.Background()); got != "0.166.0" {
		t.Fatal(got)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := Version(ctx); got != "unknown" {
		t.Fatalf("canceled context reused result: %s", got)
	}
	if count := probeCount(t, probes); count != 3 {
		t.Fatalf("failed flags plus recovery executed %d probes, want three", count)
	}
}

func TestVersionExtractsSemverToken(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only")
	}

	dir := t.TempDir()
	bin := filepath.Join(dir, "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho codex-cli 0.130.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", bin)

	if got := Version(context.Background()); got != "0.130.0" {
		t.Fatalf("Version() = %q, want 0.130.0", got)
	}
	if nativeVersionFile(bin) {
		t.Fatal("indirect script launchers must not reuse native version probes")
	}
}

func TestVersionReprobesIndirectLauncher(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only")
	}
	bin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nprintf '%s\\n' \"$CXX_TEST_SCRIPT_VERSION\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", bin)
	for _, version := range []string{"0.158.0", "0.166.0"} {
		t.Setenv("CXX_TEST_SCRIPT_VERSION", version)
		if got := Version(context.Background()); got != version {
			t.Fatalf("unchanged launcher reused an obsolete delegated version: %s, want %s", got, version)
		}
	}
}
