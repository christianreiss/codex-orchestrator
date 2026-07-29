package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func runtimeAuthHome(t *testing.T, credentials string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(credentials), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func runtimeAuthOverlayPath(t *testing.T, args []string) string {
	t.Helper()
	for i, arg := range args {
		if arg == "--settings" && i+1 < len(args) {
			return args[i+1]
		}
	}
	t.Fatalf("--settings overlay missing from args: %q", args)
	return ""
}

func TestPrepareRuntimeAuthSettingsWritesProtectedOverlay(t *testing.T) {
	home := runtimeAuthHome(t, `{"api_key":"sk-ant-api03-managed"}`)
	args := []string{"-p", "hello"}
	want, err := runtimeAuthSettingsJSON(args)
	if err != nil {
		t.Fatal(err)
	}

	got, cleanup, err := prepareRuntimeAuthSettings(args)
	if err != nil {
		t.Fatal(err)
	}

	dir := filepath.Join(home, ".clx", "state", "runtime-auth")
	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !dirInfo.IsDir() {
		t.Fatalf("%s is not a directory", dir)
	}
	if perm := dirInfo.Mode().Perm(); perm != 0o700 {
		t.Errorf("runtime auth settings directory mode=%o want 700", perm)
	}

	path := runtimeAuthOverlayPath(t, got)
	if parent := filepath.Dir(path); parent != dir {
		t.Errorf("overlay lives in %s, want %s", parent, dir)
	}
	if matched, err := filepath.Match("settings-*.json", filepath.Base(path)); err != nil || !matched {
		t.Errorf("overlay name %q does not match settings-*.json", filepath.Base(path))
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("overlay mode=%o want 600", perm)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var gotSettings, wantSettings any
	if err := json.Unmarshal(raw, &gotSettings); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &wantSettings); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotSettings, wantSettings) {
		t.Errorf("overlay contents=%s want %s", raw, want)
	}

	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("overlay survived cleanup: %v", err)
	}
}

// Every subcommand cmd/clx forwards verbatim has to take the overlay in front of
// it, or the settings file is parsed as one of the subcommand's own arguments.
// `config` and `help` used to fall through to the prompt branch and get it
// appended last.
func TestInjectRuntimeAuthSettingsPrecedesPassedThroughSubcommands(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"config", "set", "-g", "theme", "dark"}, "--settings managed.json config set -g theme dark"},
		{[]string{"help"}, "--settings managed.json help"},
		{[]string{"mcp", "list"}, "--settings managed.json mcp list"},
		{[]string{"doctor"}, "--settings managed.json doctor"},
		{[]string{"-p", "config help"}, "-p config help --settings managed.json"},
	} {
		if got := injectRuntimeAuthSettings(tc.args, "managed.json"); strings.Join(got, " ") != tc.want {
			t.Errorf("overlay order for %q = %q, want %q", tc.args, got, tc.want)
		}
	}
}

func TestCleanupStaleRuntimeAuthSettingsRemovesOnlyStaleOverlays(t *testing.T) {
	runtimeAuthHome(t, `{"api_key":"sk-ant-api03-managed"}`)
	dir, err := runtimeAuthSettingsDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	stale := now.Add(-staleRuntimeAuthSettingsAge - time.Hour)
	writeAged := func(name string, modTime time.Time) string {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, modTime, modTime); err != nil {
			t.Fatal(err)
		}
		return path
	}

	leaked := writeAged("settings-leaked.json", stale)
	live := writeAged("settings-live.json", now.Add(-staleRuntimeAuthSettingsAge+time.Hour))
	otherPrefix := writeAged("hostile-leaked.json", stale)
	otherSuffix := writeAged("settings-leaked.json.bak", stale)
	subdir := filepath.Join(dir, "settings-nested.json")
	if err := os.Mkdir(subdir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(subdir, stale, stale); err != nil {
		t.Fatal(err)
	}

	cleanupStaleRuntimeAuthSettings(dir, now)

	if _, err := os.Stat(leaked); !os.IsNotExist(err) {
		t.Errorf("leaked overlay holding a key survived the sweep: %v", err)
	}
	for _, path := range []string{live, otherPrefix, otherSuffix, subdir} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("sweep removed %s: %v", filepath.Base(path), err)
		}
	}
}
