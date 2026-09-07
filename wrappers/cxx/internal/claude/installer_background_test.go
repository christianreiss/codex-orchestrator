package claude

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func stagedInstallFixture(t *testing.T) (string, string) {
	t.Helper()
	home := t.TempDir()
	bin := filepath.Join(home, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("CLX_CLAUDE_BIN", "")
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	old := filepath.Join(bin, "claude")
	writeScript(t, old, "#!/bin/sh\necho '2.1.1 (Claude Code)'\n")
	if err := cacheClaude(old); err != nil {
		t.Fatal(err)
	}
	return home, bin
}

const stagedNpmFixture = `#!/bin/sh
test "$1" = install && test "$2" = --prefix || exit 21
stage="$3"
case "$stage" in "$HOME"/.cxx/engines/claude/*) ;; *) exit 22;; esac
test "$4" = --no-save && test "$5" = --no-audit && test "$6" = --no-fund || exit 23
test "$7" = @anthropic-ai/claude-code@2.1.2 && test "$8" = --global=false || exit 24
if test -n "$TEST_NPM_STARTED"; then
  : > "$TEST_NPM_STARTED"
  while test ! -e "$TEST_NPM_RELEASE"; do sleep 0.02; done
fi
mkdir -p "$stage/node_modules/.bin"
printf '#!/bin/sh\necho "2.1.2 (Claude Code)"\n' > "$stage/node_modules/.bin/claude"
chmod +x "$stage/node_modules/.bin/claude"
`

func TestBackgroundClaudeStageDoesNotBlockOrReplaceCurrentLaunch(t *testing.T) {
	home, bin := stagedInstallFixture(t)
	before, err := FindCLI()
	if err != nil {
		t.Fatal(err)
	}
	started, release := filepath.Join(home, "started"), filepath.Join(home, "release")
	t.Setenv("TEST_NPM_STARTED", started)
	t.Setenv("TEST_NPM_RELEASE", release)
	writeScript(t, filepath.Join(bin, "npm"), stagedNpmFixture)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- EnsureClaudeBackground(ctx, "2.1.2", true, nil) }()
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		select {
		case err := <-finished:
			t.Fatalf("install exited before fixture paused: %v", err)
		case <-ctx.Done():
			t.Fatal("installer never reached its private stage")
		case <-time.After(10 * time.Millisecond):
		}
	}
	launchCtx, launchCancel := context.WithTimeout(ctx, 500*time.Millisecond)
	if got := Version(launchCtx); got != "2.1.1" {
		launchCancel()
		t.Fatalf("foreground version blocked or changed during staged install: %q", got)
	}
	launchCancel()
	if got, _ := FindCLI(); got != before {
		t.Fatalf("unverified stage replaced existing CLI: %q", got)
	}
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	after, err := FindCLI()
	if err != nil || after == before || !isManagedClaudeCLI(after) {
		t.Fatalf("published CLI=%q, err=%v", after, err)
	}
	if got := Version(ctx); got != "2.1.2" {
		t.Fatalf("new launches see %q", got)
	}
	if out, err := exec.CommandContext(ctx, before, "--version").Output(); err != nil || !strings.Contains(string(out), "2.1.1") {
		t.Fatalf("old session's executable was changed: %q %v", out, err)
	}
	cache, _ := claudeBinCachePath()
	if raw, _ := os.ReadFile(cache); string(raw) != after {
		t.Fatalf("cache was not fully published: %q", raw)
	}
}

func TestBackgroundClaudeFailureNeverPublishesOrDamagesPreviousPrefix(t *testing.T) {
	for _, kind := range []string{"npm_failed", "wrong_version", "unrunnable", "outside_symlink"} {
		t.Run(kind, func(t *testing.T) {
			home, bin := stagedInstallFixture(t)
			before, _ := FindCLI()
			body := stagedNpmFixture
			switch kind {
			case "npm_failed":
				body += "exit 42\n"
			case "wrong_version":
				body += "printf '#!/bin/sh\\necho 9.9.9\\n' > \"$stage/node_modules/.bin/claude\"\n"
			case "unrunnable":
				body += "chmod -x \"$stage/node_modules/.bin/claude\"\n"
			case "outside_symlink":
				escape := filepath.Join(home, "outside")
				writeScript(t, escape, "#!/bin/sh\necho 2.1.2\n")
				t.Setenv("TEST_OUTSIDE", escape)
				body += "rm \"$stage/node_modules/.bin/claude\"\nln -s \"$TEST_OUTSIDE\" \"$stage/node_modules/.bin/claude\"\n"
			}
			writeScript(t, filepath.Join(bin, "npm"), body)
			if err := EnsureClaudeBackground(context.Background(), "2.1.2", true, nil); err == nil {
				t.Fatal("broken package unexpectedly accepted")
			}
			if after, _ := FindCLI(); after != before {
				t.Fatalf("failed install changed cache to %q", after)
			}
			root, _ := managedClaudeRoot()
			entries, _ := os.ReadDir(root)
			for _, entry := range entries {
				if entry.IsDir() {
					t.Fatalf("failed private stage leaked: %s", entry.Name())
				}
			}
		})
	}
}

func TestBackgroundClaudeRespectsOverrideAndNoopWithoutNpm(t *testing.T) {
	_, bin := stagedInstallFixture(t)
	t.Setenv("PATH", bin)
	if err := EnsureClaudeBackground(context.Background(), "2.1.1", true, nil); err != nil {
		t.Fatalf("matching target required npm: %v", err)
	}
	if err := EnsureClaudeBackground(context.Background(), "2.1.0", false, nil); err != nil {
		t.Fatalf("automatic downgrade required npm: %v", err)
	}
	if err := EnsureClaudeBackground(context.Background(), "2.1.2", true, nil); err == nil || !strings.Contains(err.Error(), "requires npm") {
		t.Fatalf("missing npm did not produce actionable error: %v", err)
	}
	t.Setenv("CLX_CLAUDE_BIN", filepath.Join(bin, "claude"))
	if err := EnsureClaudeBackground(context.Background(), "2.1.2", true, nil); !errors.Is(err, ErrClaudeCLIOverride) {
		t.Fatalf("override was not preserved: %v", err)
	}
}

func TestBackgroundClaudeInstallerLockHonorsCancellation(t *testing.T) {
	home, _ := stagedInstallFixture(t)
	path := filepath.Join(home, "install.lock")
	unlock, err := lockClaudeInstall(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if unlock, err := lockClaudeInstall(ctx, path); !errors.Is(err, context.DeadlineExceeded) {
		if unlock != nil {
			unlock()
		}
		t.Fatalf("contending installer did not cancel: %v", err)
	}
}

func TestBackgroundClaudeRetainsPreviouslyPublishedPrefix(t *testing.T) {
	_, bin := stagedInstallFixture(t)
	writeScript(t, filepath.Join(bin, "npm"), stagedNpmFixture)
	if err := EnsureClaudeBackground(context.Background(), "2.1.2", true, nil); err != nil {
		t.Fatal(err)
	}
	previous, _ := FindCLI()
	writeScript(t, filepath.Join(bin, "npm"), strings.ReplaceAll(stagedNpmFixture, "2.1.2", "2.1.3"))
	// The legacy entry point also uses private staging once a managed prefix
	// is selected, so an explicit caller cannot overwrite a running install.
	if err := EnsureClaude(context.Background(), "2.1.3", true, nil); err != nil {
		t.Fatal(err)
	}
	if current, _ := FindCLI(); current == previous {
		t.Fatal("second install did not publish a fresh prefix")
	}
	if got := versionFromCLI(context.Background(), previous); got != "2.1.2" {
		t.Fatalf("previous version was replaced or removed: %q", got)
	}
}

func TestClaudePathDiscoveryCannotRevertPublishedManagedCache(t *testing.T) {
	_, bin := stagedInstallFixture(t)
	stalePath, _ := FindCLI()
	cache, _ := claudeBinCachePath()
	if err := os.Remove(cache); err != nil {
		t.Fatal(err)
	}
	// A foreground lookup has already selected stalePath when background
	// publication finishes, but has not yet cached that earlier discovery.
	writeScript(t, filepath.Join(bin, "npm"), stagedNpmFixture)
	if err := EnsureClaudeBackground(context.Background(), "2.1.2", true, nil); err != nil {
		t.Fatal(err)
	}
	managed, _ := FindCLI()
	if got := cacheDiscoveredClaude(stalePath); got != managed {
		t.Fatalf("stale PATH discovery won over published managed CLI: %q", got)
	}
	if got := cachedClaudeBin(); got != managed {
		t.Fatalf("stale PATH discovery reverted cache to %q", got)
	}

	unlock, err := lockClaudeInstall(context.Background(), cache+".lock")
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	finished := make(chan string, 1)
	go func() { finished <- cacheDiscoveredClaude(stalePath) }()
	select {
	case got := <-finished:
		if got != stalePath {
			t.Fatalf("contending fallback = %q", got)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("foreground PATH fallback waited for cache publication")
	}
	if got := cachedClaudeBin(); got != managed {
		t.Fatalf("contending PATH discovery reverted cache to %q", got)
	}
}

func TestBackgroundClaudeRecoversOnlyItsStagedPostinstall(t *testing.T) {
	home, bin := stagedInstallFixture(t)
	body := stagedNpmFixture + `
chmod -x "$stage/node_modules/.bin/claude"
mkdir -p "$stage/node_modules/@anthropic-ai/claude-code"
printf '// fixture\n' > "$stage/node_modules/@anthropic-ai/claude-code/install.cjs"
`
	writeScript(t, filepath.Join(bin, "npm"), body)
	marker := filepath.Join(home, "repaired")
	t.Setenv("TEST_REPAIR_MARKER", marker)
	writeScript(t, filepath.Join(bin, "node"), `#!/bin/sh
test "$1" = "$PWD/install.cjs" || exit 31
case "$PWD" in "$HOME"/.cxx/engines/claude/*/node_modules/@anthropic-ai/claude-code) ;; *) exit 32;; esac
chmod +x "$PWD/../../.bin/claude"
: > "$TEST_REPAIR_MARKER"
`)
	if err := EnsureClaudeBackground(context.Background(), "2.1.2", true, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("staged postinstall was not recovered: %v", err)
	}
}

func TestManagedClaudeRuntimeDisablesNativeInstallationMutation(t *testing.T) {
	_, bin := stagedInstallFixture(t)
	writeScript(t, filepath.Join(bin, "npm"), stagedNpmFixture)
	if err := EnsureClaudeBackground(context.Background(), "2.1.2", true, nil); err != nil {
		t.Fatal(err)
	}
	cli, _ := FindCLI()
	env := managedClaudeEnv(cli, []string{"DISABLE_UPDATES=0", "DISABLE_AUTOUPDATER=0", "OTHER=kept"})
	joined := strings.Join(env, "\n")
	if strings.Contains(joined, "=0") || !strings.Contains(joined, "OTHER=kept") || !strings.Contains(joined, "DISABLE_UPDATES=1") || !strings.Contains(joined, "DISABLE_AUTOUPDATER=1") {
		t.Fatalf("managed environment: %q", joined)
	}
	raw, err := runtimeAuthSettingsJSONForCLI(nil, cli)
	if err != nil {
		t.Fatal(err)
	}
	var overlay struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(raw, &overlay); err != nil {
		t.Fatal(err)
	}
	if overlay.Env["DISABLE_UPDATES"] != "1" || overlay.Env["DISABLE_AUTOUPDATER"] != "1" {
		t.Fatal("settings overlay permits native self-update")
	}
	globalCLI := filepath.Join(bin, "claude")
	globalEnv := strings.Join(managedClaudeEnv(globalCLI, []string{"DISABLE_UPDATES=0", "DISABLE_AUTOUPDATER=0"}), "\n")
	if !strings.Contains(globalEnv, "DISABLE_UPDATES=0") || !strings.Contains(globalEnv, "DISABLE_AUTOUPDATER=1") || strings.Contains(globalEnv, "DISABLE_AUTOUPDATER=0") {
		t.Fatalf("global CLI automatic/manual update controls: %q", globalEnv)
	}
	globalRaw, err := runtimeAuthSettingsJSONForCLI(nil, globalCLI)
	if err != nil {
		t.Fatal(err)
	}
	var globalOverlay struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(globalRaw, &globalOverlay); err != nil {
		t.Fatal(err)
	}
	if globalOverlay.Env["DISABLE_AUTOUPDATER"] != "1" || globalOverlay.Env["DISABLE_UPDATES"] != "" {
		t.Fatal("global CLI overlay must disable automatic updates and retain manual updates")
	}
}
