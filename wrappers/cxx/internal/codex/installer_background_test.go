package codex

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

type backgroundReleaseFixture struct {
	native, companion string
	badDigest         bool
	missingCompanion  bool
	beforeNative      func(*http.Request)
}

func backgroundFixture(t *testing.T, fixture backgroundReleaseFixture) (string, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CDX_CODEX_BIN", "")
	t.Setenv("CDX_CODEX_INSTALL_DIR", filepath.Join(home, "global"))
	bin := filepath.Join(home, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	oldCLI := filepath.Join(bin, "codex")
	writeBackgroundExecutable(t, oldCLI, "#!/bin/sh\ncase \"$1\" in -V|--version) echo 'codex 1.0.0'; exit 0;; esac\necho ready\nread ignored\n\"${0%/*}/codex-code-mode-host\" --help\n")
	writeBackgroundExecutable(t, filepath.Join(bin, codeModeHostBinName), "#!/bin/sh\necho old-companion\n")
	writeBackgroundExecutable(t, filepath.Join(bin, "npm"), "#!/bin/sh\necho called >> \"$HOME/npm-called\"\nexit 0\n")
	if err := cacheCodex(oldCLI); err != nil {
		t.Fatal(err)
	}
	if fixture.native == "" {
		fixture.native = "#!/bin/sh\necho 'codex 9.9.9'\n"
	}
	if fixture.companion == "" {
		fixture.companion = "#!/bin/sh\necho new-companion\n"
	}
	cliPrefix, err := assetPrefixFor("codex", runtime.GOOS, runtime.GOARCH)
	if err != nil {
		t.Skip(err)
	}
	companionPrefix, err := assetPrefixFor(codeModeHostBinName, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	asset := func(name, url, body string) Asset {
		sum := sha256.Sum256([]byte(body))
		return Asset{Name: name, DownloadURL: url, Digest: "sha256:" + hex.EncodeToString(sum[:]), Size: int64(len(body))}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/repos/openai/codex/releases/"):
			native := asset(cliPrefix, "http://"+r.Host+"/native", fixture.native)
			if fixture.badDigest {
				native.Digest = "sha256:" + strings.Repeat("0", 64)
			}
			assets := []Asset{native}
			if !fixture.missingCompanion {
				assets = append(assets, asset(companionPrefix, "http://"+r.Host+"/companion", fixture.companion))
			}
			_ = json.NewEncoder(w).Encode(Release{TagName: "rust-v9.9.9", Assets: assets})
		case r.URL.Path == "/native":
			if fixture.beforeNative != nil {
				fixture.beforeNative(r)
			}
			_, _ = io.WriteString(w, fixture.native)
		case r.URL.Path == "/companion":
			_, _ = io.WriteString(w, fixture.companion)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	previous := githubBaseURL
	githubBaseURL = srv.URL
	t.Cleanup(func() { githubBaseURL = previous })
	return home, oldCLI
}

func writeBackgroundExecutable(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

func backgroundLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestBackgroundUpgradePublishesOnlyAfterValidationAndPreservesRunningChild(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	home, oldCLI := backgroundFixture(t, backgroundReleaseFixture{beforeNative: func(r *http.Request) {
		close(started)
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}})
	t.Cleanup(unblock)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, oldCLI)
	in, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(out)
	if line, err := reader.ReadString('\n'); err != nil || line != "ready\n" {
		t.Fatalf("old child ready: %q, %v", line, err)
	}
	updated := make(chan error, 1)
	go func() { updated <- EnsureCodexBackground(ctx, "9.9.9", true, backgroundLogger()) }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("background download did not start")
	}
	// The download cannot finish until explicitly released. Lookup and a real
	// new child must nevertheless complete, without touching the installer lock.
	cli, err := FindCLI()
	if err != nil || cli != oldCLI {
		t.Fatalf("unpublished lookup = %q, %v", cli, err)
	}
	launchCtx, launchCancel := context.WithTimeout(ctx, time.Second)
	launched, err := exec.CommandContext(launchCtx, cli, "--version").Output()
	launchCancel()
	if err != nil || !strings.Contains(string(launched), "1.0.0") {
		t.Fatalf("launch during stalled download: %q, %v", launched, err)
	}
	unblock()
	if err := <-updated; err != nil {
		t.Fatal(err)
	}
	cli, err = FindCLI()
	root := filepath.Join(home, ".cxx", "engines", "codex")
	if err != nil || cli == oldCLI || !strings.HasPrefix(cli, root+string(os.PathSeparator)) {
		t.Fatalf("published lookup = %q, %v", cli, err)
	}
	if got := Version(ctx); got != "9.9.9" {
		t.Fatalf("new launch version = %q", got)
	}
	_, _ = io.WriteString(in, "continue\n")
	_ = in.Close()
	if line, err := reader.ReadString('\n'); err != nil || line != "old-companion\n" {
		t.Fatalf("running child lost original companion: %q, %v", line, err)
	}
	if err := child.Wait(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(oldCLI); err != nil {
		t.Fatalf("old CLI removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "npm-called")); !os.IsNotExist(err) {
		t.Fatalf("background used global npm: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "global")); !os.IsNotExist(err) {
		t.Fatalf("background modified explicit global destination: %v", err)
	}
}

func TestBackgroundUpgradeFailurePreservesSelectedRelease(t *testing.T) {
	for _, tc := range []struct {
		name    string
		fixture backgroundReleaseFixture
		want    string
	}{
		{"digest", backgroundReleaseFixture{badDigest: true}, "sha mismatch"},
		{"missing companion", backgroundReleaseFixture{missingCompanion: true}, "companion"},
		{"wrong native version", backgroundReleaseFixture{native: "#!/bin/sh\necho 'codex 9.9.8'\n"}, "does not match"},
		{"broken companion", backgroundReleaseFixture{companion: "#!/bin/sh\nexit 42\n"}, "validate staged Codex companion"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home, oldCLI := backgroundFixture(t, tc.fixture)
			err := EnsureCodexBackground(context.Background(), "9.9.9", true, backgroundLogger())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
			if cli, err := FindCLI(); err != nil || cli != oldCLI {
				t.Fatalf("failure changed selected CLI: %q, %v", cli, err)
			}
			entries, err := os.ReadDir(filepath.Join(home, ".cxx", "engines", "codex"))
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if entry.IsDir() {
					t.Fatalf("failed unpublished stage left behind: %s", entry.Name())
				}
			}
		})
	}
}

func TestBackgroundUpgradeCancellationPreservesCache(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, oldCLI := backgroundFixture(t, backgroundReleaseFixture{beforeNative: func(r *http.Request) {
		cancel()
		<-r.Context().Done()
	}})
	if err := EnsureCodexBackground(ctx, "9.9.9", true, backgroundLogger()); err == nil {
		t.Fatal("canceled install succeeded")
	}
	if cli, err := FindCLI(); err != nil || cli != oldCLI {
		t.Fatalf("canceled install changed selected CLI: %q, %v", cli, err)
	}
}

func TestExplicitUpdateAdvancesManagedCachedCLI(t *testing.T) {
	home, _ := backgroundFixture(t, backgroundReleaseFixture{})
	oldCLI := filepath.Join(home, ".cxx", "engines", "codex", "1.0.0-old", "codex")
	writeBackgroundExecutable(t, oldCLI, "#!/bin/sh\necho 'codex 1.0.0'\n")
	if err := cacheCodex(oldCLI); err != nil {
		t.Fatal(err)
	}
	if err := EnsureCodex(context.Background(), "v9.9.9", true, backgroundLogger()); err != nil {
		t.Fatal(err)
	}
	if got := Version(context.Background()); got != "9.9.9" {
		t.Fatalf("explicit update retained stale cache: %q", got)
	}
	if _, err := os.Stat(oldCLI); err != nil {
		t.Fatalf("explicit update removed running release: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "npm-called")); !os.IsNotExist(err) {
		t.Fatalf("explicit update used global npm despite managed selection: %v", err)
	}
}

func TestBackgroundUpdateRespectsExplicitCLIOverride(t *testing.T) {
	_, oldCLI := backgroundFixture(t, backgroundReleaseFixture{})
	t.Setenv("CDX_CODEX_BIN", oldCLI)
	if err := EnsureCodexBackground(context.Background(), "9.9.9", true, backgroundLogger()); err == nil || !strings.Contains(err.Error(), "CDX_CODEX_BIN") {
		t.Fatalf("explicit override not reported: %v", err)
	}
	if got := Version(context.Background()); got != "1.0.0" {
		t.Fatalf("override changed: %q", got)
	}
}

func TestStalePathDiscoveryCannotReplacePublishedRelease(t *testing.T) {
	home, oldCLI := backgroundFixture(t, backgroundReleaseFixture{})
	cachePath, _ := codexBinCachePath()
	if err := os.Remove(cachePath); err != nil {
		t.Fatal(err)
	}
	// A launch observed the empty cache and resolved this old PATH executable.
	discovered, err := exec.LookPath("codex")
	if err != nil || discovered != oldCLI {
		t.Fatalf("discover old CLI: %q, %v", discovered, err)
	}
	newCLI := filepath.Join(home, ".cxx", "engines", "codex", "9.9.9-ready", "codex")
	writeBackgroundExecutable(t, newCLI, "#!/bin/sh\necho 'codex 9.9.9'\n")
	if err := cacheCodex(newCLI); err != nil {
		t.Fatal(err)
	}
	if got := cacheDiscoveredCodex(discovered); got != newCLI {
		t.Fatalf("stale discovery ignored published winner: %q", got)
	}
	if got := cachedCodexBin(); got != newCLI {
		t.Fatalf("stale discovery replaced cache: %q", got)
	}
}

func TestColdCacheLaunchNeverWaitsForPublicationLock(t *testing.T) {
	_, oldCLI := backgroundFixture(t, backgroundReleaseFixture{})
	cachePath, _ := codexBinCachePath()
	if err := os.Remove(cachePath); err != nil {
		t.Fatal(err)
	}
	lock, err := ipc.TryAcquireExclusivePath(cachePath + ".lock")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	lookup := make(chan string, 1)
	go func() {
		cli, _ := FindCLI()
		lookup <- cli
	}()
	select {
	case cli := <-lookup:
		if cli != oldCLI {
			t.Fatalf("busy publication lookup = %q", cli)
		}
	case <-time.After(time.Second):
		t.Fatal("foreground lookup waited for publication lock")
	}
	if _, err := os.Stat(cachePath); !os.IsNotExist(err) {
		t.Fatalf("discovery wrote while publisher held lock: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := cacheCodexContext(ctx, oldCLI); err != context.DeadlineExceeded {
		t.Fatalf("publication did not respect cancellation: %v", err)
	}
}
