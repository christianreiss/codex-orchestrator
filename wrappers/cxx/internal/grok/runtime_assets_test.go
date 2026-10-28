package grok

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pelletier/go-toml"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func writeBaseAsset(t *testing.T, base, name, body string, mode os.FileMode) {
	t.Helper()
	path := filepath.Join(base, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
}

func runtimeWithBase(t *testing.T, seed func(base string)) *Runtime {
	t.Helper()
	r, pool := runtimeFixture(t)
	base := r.BaseHome
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	seed(base)
	next, err := NewRuntime(base, &config.Config{}, nil, pool)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = next.Close() })
	return next
}

// Native writes these by atomic rename, and every write-denying sandbox
// profile refuses symlinked protected files, so the private home holds real
// snapshot copies. The legacy hyphenated managed name was never read natively.
func TestRuntimeCarriesNativeHomeFilesAsSnapshots(t *testing.T) {
	copied := map[string]string{
		"trusted_folders.toml":      "[folders.\"/work/trusted\"]\ntrusted = true\ndecided_at = 1\n",
		"managed_config.toml":       "[models]\ndefault = \"org-default\"\n",
		"managed_config.sig.json":   `{"signatures":[]}`,
		"managed_identity.sig.json": `{"signatures":[]}`,
		"requirements.toml":         "fail_closed = false\n",
		"sandbox.toml":              "[profiles.probe]\nextends = \"workspace\"\n",
		"sandbox_grants.toml":       "# grants\n",
		"pager.toml":                "[scrollback.blocks.edit]\nexpanded_by_default = false\n",
		"lsp.json":                  `{"servers":{}}`,
		"hooks-paths":               "/opt/team-hooks\n",
		"disabled-hooks":            "user:example\n",
		"trusted-plugins":           "plugin-a\n",
		"trusted-hook-projects":     "/work/legacy\n",
		"config.toml":               "[ui]\ntimestamps = true\n",
	}
	excluded := []string{"managed-config.toml", "trusted_folders.toml.lock", "sandbox_grants.toml.lock", "managed_config.lock",
		"managed_config_cache.json", "managed_config_refresh.json", "settings_cache.json", "models_cache.json",
		"mcp_credentials.json", "worktrees.db", "version.json", "agent_id", "extensions", "grove", "downloads", "bin", "logs"}
	r := runtimeWithBase(t, func(base string) {
		for name, body := range copied {
			writeBaseAsset(t, base, name, body, 0o600)
		}
		for _, name := range excluded {
			writeBaseAsset(t, base, name, "excluded fixture", 0o600)
		}
	})
	for name, body := range copied {
		info, err := os.Lstat(filepath.Join(r.Home, name))
		if err != nil || !info.Mode().IsRegular() {
			t.Fatalf("%s not carried as a regular file: %v", name, err)
		}
		raw, _ := os.ReadFile(filepath.Join(r.Home, name))
		if string(raw) != body {
			t.Fatalf("%s snapshot differs", name)
		}
	}
	for _, name := range excluded {
		if _, err := os.Lstat(filepath.Join(r.Home, name)); !os.IsNotExist(err) {
			t.Fatalf("%s must not be carried into the private home", name)
		}
	}
	// An in-session native trust decision replaces the private file by rename
	// and must not reach the operator's own store after teardown.
	if err := AtomicWrite(filepath.Join(r.Home, "trusted_folders.toml"), []byte("[folders.\"/work/other\"]\ntrusted = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	for name, body := range copied {
		raw, _ := os.ReadFile(filepath.Join(r.BaseHome, name))
		if string(raw) != body {
			t.Fatalf("base %s changed by a managed session", name)
		}
	}
}

func TestRuntimeLinksPersistentNativeDirectories(t *testing.T) {
	linked := []string{"workflows", "installed-plugins", "marketplace-cache", "plugin-data", "roles", "personas", "plugins", "bundled", "bundles"}
	r := runtimeWithBase(t, func(base string) {
		for _, name := range linked {
			writeBaseAsset(t, base, filepath.Join(name, "fixture"), name, 0o600)
		}
	})
	for _, name := range linked {
		target, err := os.Readlink(filepath.Join(r.Home, name))
		if err != nil || target != filepath.Join(r.BaseHome, name) {
			t.Fatalf("%s not shared with the original home: %q %v", name, target, err)
		}
	}
	for _, name := range []string{"roles", "workflows"} {
		if _, err := os.Lstat(filepath.Join(r.Home, name)); err != nil {
			t.Fatal(err)
		}
	}
}

// Every write-denying native sandbox profile refuses a symlinked built-in
// bundle cache (Grok 1.0.70: "hook source path contains a symlink component").
func TestRuntimeCopiesBundleCachesWhenASandboxProfileIsSelected(t *testing.T) {
	for _, scenario := range []string{"off", "config", "overlay", "flag", "env", "requirements", "managed"} {
		t.Run(scenario, func(t *testing.T) {
			r := runtimeWithBase(t, func(base string) {
				writeBaseAsset(t, base, "bundled/manifest.json", `{"version":"fixture"}`, 0o644)
				writeBaseAsset(t, base, "bundled/skills/tool/run.sh", "#!/bin/sh\n", 0o755)
				writeBaseAsset(t, base, "bundles/cache.bin", "bundle", 0o644)
				switch scenario {
				case "off":
					writeBaseAsset(t, base, "config.toml", "[sandbox]\nprofile = \"off\"\n", 0o600)
				case "config":
					writeBaseAsset(t, base, "config.toml", "[sandbox]\nprofile = \"workspace\"\n", 0o600)
				case "requirements":
					writeBaseAsset(t, base, "requirements.toml", "[sandbox]\nprofile = \"strict\"\n", 0o600)
				case "managed":
					writeBaseAsset(t, base, "managed_config.toml", "[sandbox]\nprofile = \"team\"\n", 0o600)
				}
			})
			var args []string
			switch scenario {
			case "overlay":
				t.Setenv("GROK_CONFIG", `{"sandbox":{"profile":"read-only"}}`)
			case "flag":
				args = []string{"--sandbox", "strict"}
			case "env":
				t.Setenv("GROK_SANDBOX", "workspace")
			}
			if err := r.Configure("/fixture/cxx", &config.Config{}, false, args); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"bundled", "bundles"} {
				info, err := os.Lstat(filepath.Join(r.Home, name))
				if err != nil {
					t.Fatal(err)
				}
				if scenario == "off" {
					if info.Mode()&os.ModeSymlink == 0 {
						t.Fatalf("%s copied although no sandbox profile is selected", name)
					}
					continue
				}
				if !info.IsDir() {
					t.Fatalf("%s is not a real directory under a sandbox profile", name)
				}
			}
			if scenario == "off" {
				return
			}
			script, err := os.Stat(filepath.Join(r.Home, "bundled", "skills", "tool", "run.sh"))
			if err != nil || script.Mode().Perm()&0o100 == 0 {
				t.Fatalf("bundled script not copied executable: %v", err)
			}
			if raw, _ := os.ReadFile(filepath.Join(r.Home, "bundled", "manifest.json")); string(raw) != `{"version":"fixture"}` {
				t.Fatal("bundle manifest not copied")
			}
			if err := r.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(r.BaseHome, "bundled", "skills", "tool", "run.sh")); err != nil {
				t.Fatal("original bundle cache changed by teardown")
			}
		})
	}
}

func receiverCommands(t *testing.T, tree *toml.Tree, event string) []string {
	t.Helper()
	var commands []string
	groups, _ := tree.Get("hooks." + event).([]*toml.Tree)
	for _, group := range groups {
		switch handlers := group.Get("hooks").(type) {
		case []*toml.Tree:
			for _, handler := range handlers {
				command, _ := handler.Get("command").(string)
				commands = append(commands, command)
			}
		case []interface{}:
			for _, handler := range handlers {
				if m, ok := handler.(map[string]interface{}); ok {
					command, _ := m["command"].(string)
					commands = append(commands, command)
				}
			}
		}
	}
	return commands
}

// Grok 1.0.64+ holds back user hooks in untrusted folders. The fleet lifecycle
// hooks therefore use the private managed layer, which native loads before
// folder trust; organization content in the copied file is preserved.
func TestRuntimeDeliversReceiverHooksThroughPrivateManagedLayer(t *testing.T) {
	org := "[models]\ndefault = \"org-default\"\n\n[[hooks.SessionStart]]\nhooks = [ { type = \"command\", command = \"/opt/org/start\" } ]\n"
	r := runtimeWithBase(t, func(base string) {
		writeBaseAsset(t, base, "managed_config.toml", org, 0o600)
		writeBaseAsset(t, base, "hooks/user.json", `{"hooks":{}}`, 0o600)
	})
	if err := r.Configure("/path with spaces/cxx", &config.Config{}, true); err != nil {
		t.Fatal(err)
	}
	if len(r.Warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", r.Warnings)
	}
	raw, err := os.ReadFile(filepath.Join(r.Home, "managed_config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	tree, err := toml.LoadBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	if tree.Get("models.default") != "org-default" {
		t.Fatal("organization managed defaults lost")
	}
	start := receiverCommands(t, tree, "SessionStart")
	if len(start) != 2 || start[0] != "/opt/org/start" || start[1] != "'/path with spaces/cxx' agent native-session" {
		t.Fatalf("SessionStart hooks=%q", start)
	}
	for _, event := range []string{"StopFailure", "StopCancelled", "SessionEnd"} {
		if got := receiverCommands(t, tree, event); len(got) != 1 || got[0] != "'/path with spaces/cxx' agent watchdog-event" {
			t.Fatalf("%s hooks=%q", event, got)
		}
	}
	if _, err := os.Lstat(filepath.Join(r.Home, "hooks", "cxx-receiver.json")); !os.IsNotExist(err) {
		t.Fatal("receiver hooks duplicated into the trust-gated user layer")
	}
	if _, err := os.Stat(filepath.Join(r.Home, "hooks", "user.json")); err != nil {
		t.Fatal("user hook definitions not carried")
	}
	if base, _ := os.ReadFile(filepath.Join(r.BaseHome, "managed_config.toml")); string(base) != org {
		t.Fatal("original managed configuration changed")
	}
}

func TestRuntimeLeavesManagedLayerUntouchedWithoutReceiver(t *testing.T) {
	org := "# org comment\n[models]\ndefault = \"org-default\"\n"
	r := runtimeWithBase(t, func(base string) { writeBaseAsset(t, base, "managed_config.toml", org, 0o600) })
	if err := r.Configure("/fixture/cxx", &config.Config{}, false); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(r.Home, "managed_config.toml")); string(raw) != org {
		t.Fatal("managed snapshot rewritten without receiver hooks")
	}
	// Without an organization file a receiver launch creates a fleet-only layer.
	empty, _ := runtimeFixture(t)
	if err := empty.Configure("/fixture/cxx", &config.Config{}, true); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(empty.Home, "managed_config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	tree, err := toml.LoadBytes(raw)
	if err != nil || len(receiverCommands(t, tree, "SessionStart")) != 1 {
		t.Fatalf("fleet-only managed layer invalid: %v %s", err, raw)
	}
}

// An unreadable organization file is never rewritten: the hooks fall back to
// the user layer and the launch says that they wait for folder trust.
func TestRuntimeFallsBackToUserHooksWhenManagedLayerCannotBeParsed(t *testing.T) {
	broken := "[models\ndefault = \n"
	r := runtimeWithBase(t, func(base string) { writeBaseAsset(t, base, "managed_config.toml", broken, 0o600) })
	if err := r.Configure("/fixture/cxx", &config.Config{}, true); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(r.Home, "managed_config.toml")); string(raw) != broken {
		t.Fatal("unparseable organization file rewritten")
	}
	raw, err := os.ReadFile(filepath.Join(r.Home, "hooks", "cxx-receiver.json"))
	if err != nil || !bytes.Contains(raw, []byte("agent native-session")) {
		t.Fatalf("fallback receiver hooks missing: %v", err)
	}
	if len(r.Warnings) != 1 || !strings.Contains(r.Warnings[0], "folder trust") {
		t.Fatalf("fallback not reported: %v", r.Warnings)
	}
}

// Opt-in acceptance against a real native binary (CXX_TEST_GROK_BIN). It runs
// only `inspect --json` in a throwaway home: no login, no inference.
func TestRuntimeNativeInspectSeesManagedReceiverHooksInUntrustedFolder(t *testing.T) {
	binary := os.Getenv("CXX_TEST_GROK_BIN")
	if binary == "" {
		t.Skip("set CXX_TEST_GROK_BIN to a native Grok binary to run")
	}
	repo := t.TempDir()
	if out, err := exec.Command("git", "-C", repo, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	userHook := `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/bin/true user-own"}]}]}}`
	inspect := func(r *Runtime) map[string]any {
		cmd := exec.Command(binary, "inspect", "--json")
		cmd.Dir = repo
		cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + filepath.Dir(r.BaseHome), "GROK_HOME=" + r.Home, "GROK_DISABLE_AUTOUPDATER=1", "TERM=dumb"}
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("native inspect: %v", err)
		}
		var doc map[string]any
		if err := json.Unmarshal(out, &doc); err != nil {
			t.Fatal(err)
		}
		return doc
	}
	hooks := func(doc map[string]any) map[string]string {
		found := map[string]string{}
		list, _ := doc["hooks"].([]any)
		for _, item := range list {
			h, _ := item.(map[string]any)
			source, _ := h["source"].(map[string]any)
			target, _ := h["target"].(string)
			found[target], _ = source["type"].(string)
		}
		return found
	}
	for _, trusted := range []bool{false, true} {
		r := runtimeWithBase(t, func(base string) {
			writeBaseAsset(t, base, "hooks/user.json", userHook, 0o600)
			writeBaseAsset(t, base, "sandbox.toml", "[profiles.probe]\nextends = \"workspace\"\n", 0o600)
			if os.Getenv("CXX_TEST_GROK_SANDBOX") == "1" {
				writeBaseAsset(t, base, "config.toml", "[sandbox]\nprofile = \"probe\"\n", 0o600)
				writeBaseAsset(t, base, "bundled/manifest.json", `{"version":"fixture"}`, 0o644)
			}
			if trusted {
				writeBaseAsset(t, base, "trusted_folders.toml", "[folders.\""+repo+"\"]\ntrusted = true\ndecided_at = 1\n", 0o600)
			}
		})
		if err := r.Configure("/fixture/cxx", &config.Config{}, true); err != nil {
			t.Fatal(err)
		}
		doc := inspect(r)
		found := hooks(doc)
		if found["'/fixture/cxx' agent native-session"] != "managed" {
			t.Fatalf("trusted=%v: receiver hook not delivered by the managed layer: %v", trusted, found)
		}
		// The operator's own trust decision, carried read-only, still governs
		// their own hooks; the fleet grants no folder trust. Natives before
		// 1.0.64 report every folder trusted and load user hooks anyway.
		projectTrusted, _ := doc["projectTrusted"].(bool)
		_, userHook := found["/bin/true user-own"]
		if trusted && (!projectTrusted || !userHook) {
			t.Fatalf("carried trust store ignored: trusted=%v hooks=%v", projectTrusted, found)
		}
		if !projectTrusted && userHook {
			t.Fatalf("user hook loaded in an untrusted folder: %v", found)
		}
		if os.Getenv("CXX_TEST_GROK_SANDBOX") == "1" {
			// Custom profile and bundle cache resolution happen before auth; the
			// fixture provider cannot authenticate, so nothing reaches inference.
			cmd := exec.Command(binary, "-p", "fixture")
			cmd.Dir = repo
			cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + filepath.Dir(r.BaseHome), "GROK_HOME=" + r.Home, "GROK_DISABLE_AUTOUPDATER=1", "TERM=dumb"}
			out, _ := cmd.CombinedOutput()
			t.Logf("sandboxed native start: %.200s", out)
			if bytes.Contains(out, []byte("profile 'probe' not found")) || bytes.Contains(out, []byte("symlink component")) {
				t.Fatalf("sandbox profile refused in the private home: %s", out)
			}
		}
	}
}
