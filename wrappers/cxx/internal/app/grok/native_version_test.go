package grok

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func launchVersionFixture(t *testing.T) (string, string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	cli, probes := filepath.Join(dir, "grok"), filepath.Join(dir, "probes")
	if err := os.WriteFile(cli, data, 0o700); err != nil {
		t.Fatal(err)
	}
	if !directVersionExecutable(cli) {
		t.Skip("version reuse requires ELF or Mach-O")
	}
	t.Setenv("CXX_TEST_GROK_VERSION", "1.0.50")
	t.Setenv("CXX_TEST_GROK_VERSION_PROBES", probes)
	return cli, probes
}

func TestLaunchVersionReusesOnlyWithinOneNativeLaunch(t *testing.T) {
	cli, probes := launchVersionFixture(t)
	t.Setenv("CGX_GROK_BIN", cli)
	var probe launchVersionProbe
	if err := probe.requireInstalled(context.Background()); err != nil {
		t.Fatal(err)
	}
	if version, err := probe.supported(context.Background(), cli); err != nil || version != "1.0.50" {
		t.Fatalf("launch check: %q, %v", version, err)
	}
	if data, err := os.ReadFile(probes); err != nil || string(data) != "probe\n" {
		t.Fatalf("same launch repeated probe: %q, %v", data, err)
	}
	var next launchVersionProbe
	if _, err := next.supported(context.Background(), cli); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(probes); err != nil || string(data) != "probe\nprobe\n" {
		t.Fatalf("version evidence survived a launch: %q, %v", data, err)
	}
}

func TestLaunchVersionReprobesIndirectLauncher(t *testing.T) {
	cli := filepath.Join(t.TempDir(), "grok")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\necho \"grok $CXX_TEST_GROK_VERSION\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CXX_TEST_GROK_VERSION", "1.0.50")
	var probe launchVersionProbe
	if _, err := probe.supported(context.Background(), cli); err != nil {
		t.Fatal(err)
	}
	// The launcher metadata is unchanged, but its delegated version has changed.
	t.Setenv("CXX_TEST_GROK_VERSION", "1.0.46")
	if _, err := probe.supported(context.Background(), cli); err == nil {
		t.Fatal("unchanged launcher hid an unsupported version")
	}
}

func TestOldNativeLaunchStopsBeforeConfigSyncOrAccountLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	t.Setenv("GROK_HOME", dir)
	cli := filepath.Join(dir, "grok")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf 'grok 1.0.46\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CGX_GROK_BIN", cli)
	settings := filepath.Join(dir, "config.toml")
	const original = "[ui]\npermission_mode = 'default'\n"
	if err := os.WriteFile(settings, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	// A nil client makes any accidental config sync/account request fail loudly.
	code, err := run(context.Background(), &config.Config{}, nil, options{}, io.Discard, io.Discard)
	if code != 1 || err == nil || !strings.Contains(err.Error(), "1.0.50") || !strings.Contains(err.Error(), "cgx update") {
		t.Fatalf("old native launch: code=%d error=%v", code, err)
	}
	if data, err := os.ReadFile(settings); err != nil || string(data) != original {
		t.Fatalf("settings changed before refusal: %q, %v", data, err)
	}
}

func TestLaunchVersionRechecksChangedExecutable(t *testing.T) {
	for _, change := range []string{"replace", "mtime", "retarget", "remove", "mode"} {
		t.Run(change, func(t *testing.T) {
			cli, _ := launchVersionFixture(t)
			dir := filepath.Dir(cli)
			supported, err := os.ReadFile(cli)
			if err != nil {
				t.Fatal(err)
			}
			var probe launchVersionProbe
			if _, err := probe.supported(context.Background(), cli); err != nil {
				t.Fatal(err)
			}
			original, err := os.Stat(cli)
			if err != nil {
				t.Fatal(err)
			}
			other := filepath.Join(dir, "other")
			if err := os.WriteFile(other, supported, 0o700); err != nil {
				t.Fatal(err)
			}
			// An atomic installer can preserve size, permissions and timestamp.
			if err := os.Chtimes(other, original.ModTime(), original.ModTime()); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CXX_TEST_GROK_VERSION", "1.0.46")
			switch change {
			case "replace":
				err = os.Rename(other, cli)
			case "mtime":
				err = os.Chtimes(cli, original.ModTime(), original.ModTime().Add(time.Second))
			case "retarget":
				err = os.Remove(cli)
				if err == nil {
					err = os.Symlink(other, cli)
				}
			case "remove":
				err = os.Remove(cli)
			case "mode":
				err = os.Chmod(cli, 0o600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if version, err := probe.supported(context.Background(), cli); err == nil {
				t.Fatalf("changed executable reused %q", version)
			}
		})
	}
}

func TestLaunchVersionDoesNotCacheFailedProbeOrIgnoreCancellation(t *testing.T) {
	cli, _ := launchVersionFixture(t)
	t.Setenv("CXX_TEST_GROK_VERSION_FAIL", "1")
	var probe launchVersionProbe
	if _, err := probe.supported(context.Background(), cli); err == nil {
		t.Fatal("expected initial probe failure")
	}
	t.Setenv("CXX_TEST_GROK_VERSION_FAIL", "")
	if version, err := probe.supported(context.Background(), cli); err != nil || version != "1.0.50" {
		t.Fatalf("failed probe persisted: %q, %v", version, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := probe.supported(ctx, cli); err != context.Canceled {
		t.Fatalf("cached result ignored cancellation: %v", err)
	}
}

func TestNativeLaunchVersionProbeAcceptsCurrentAndRejectsPrereleaseOrUnknown(t *testing.T) {
	for _, fixture := range []struct {
		version string
		allowed bool
	}{{"1.0.50", true}, {"1.0.51", true}, {"1.0.50-rc.1", false}, {"unknown", false}} {
		t.Run(fixture.version, func(t *testing.T) {
			cli := filepath.Join(t.TempDir(), "grok")
			if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf 'grok "+fixture.version+"\\n'\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			var probe launchVersionProbe
			_, err := probe.supported(context.Background(), cli)
			if (err == nil) != fixture.allowed {
				t.Fatalf("version %s: %v", fixture.version, err)
			}
		})
	}
}
