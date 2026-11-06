package lifecycle

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claudeconfiglock"
)

func setUserConfigLockBudget(t *testing.T, budget time.Duration) {
	t.Helper()
	prev := userConfigLockOptions
	userConfigLockOptions = claudeconfiglock.Options{Budget: budget}
	t.Cleanup(func() { userConfigLockOptions = prev })
}

// holdNativeLock creates Claude Code's lock directory with the given age, the
// way a native saveConfigWithLock holder (proper-lockfile) leaves it.
func holdNativeLock(t *testing.T, age time.Duration) string {
	t.Helper()
	dir := claudeconfiglock.Path(userConfigPath())
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(-age)
	if err := os.Chtimes(dir, at, at); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestApplyUserMcpServersDefersWhileNativeHoldsLock(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	setUserConfigLockBudget(t, 30*time.Millisecond)
	original := []byte("{\n  \"oauthAccount\": {\"accountUuid\": \"a\"}\n}\n")
	if err := os.WriteFile(userConfigPath(), original, 0o600); err != nil {
		t.Fatal(err)
	}
	lockDir := holdNativeLock(t, time.Second)

	servers := map[string]any{"clx": map[string]any{"url": "https://fleet.test/mcp"}}
	changed, err := applyUserMcpServersResult(servers, slog.Default())
	if changed || !errors.Is(err, ErrUserConfigLocked) {
		t.Fatalf("held lock apply = (%t, %v), want deferred ErrUserConfigLocked", changed, err)
	}
	if !bytesEqual(readFile(t, userConfigPath()), original) {
		t.Fatal("a held native lock must leave ~/.claude.json byte-identical")
	}
	if _, err := os.Stat(managedMcpStatePath()); !os.IsNotExist(err) {
		t.Fatalf("deferred merge must not record ownership: %v", err)
	}
	if _, err := os.Stat(lockDir); err != nil {
		t.Fatalf("live native lock must not be removed: %v", err)
	}

	// The holder finishes; the next sync lands the deferred merge.
	if err := os.Remove(lockDir); err != nil {
		t.Fatal(err)
	}
	if changed, err := applyUserMcpServersResult(servers, slog.Default()); !changed || err != nil {
		t.Fatalf("retry after release = (%t, %v), want written", changed, err)
	}
	if names := loadManagedMcpState().Names; len(names) != 1 || names[0] != "clx" {
		t.Fatalf("retry must record ownership, got %v", names)
	}
	if _, err := os.Stat(lockDir); !os.IsNotExist(err) {
		t.Fatalf("wrapper must release its lock: %v", err)
	}
}

func TestApplyUserMcpServersTakesOverStaleLock(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	setUserConfigLockBudget(t, 30*time.Millisecond)
	if err := os.WriteFile(userConfigPath(), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Older than native's 10s stale threshold: a crashed holder.
	lockDir := holdNativeLock(t, 11*time.Second)
	servers := map[string]any{"clx": map[string]any{"url": "https://fleet.test/mcp"}}
	if changed, err := applyUserMcpServersResult(servers, slog.Default()); !changed || err != nil {
		t.Fatalf("stale lock apply = (%t, %v), want written", changed, err)
	}
	if _, err := os.Stat(lockDir); !os.IsNotExist(err) {
		t.Fatalf("lock must be released after the takeover write: %v", err)
	}
}

func TestStripUserMcpServersDefersWhileNativeHoldsLock(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	setUserConfigLockBudget(t, 30*time.Millisecond)
	if !applyUserMcpServers(map[string]any{"clx": map[string]any{"url": "https://fleet.test/mcp"}}, slog.Default()) {
		t.Fatal("managed MCP server was not applied")
	}
	before := readFile(t, userConfigPath())
	holdNativeLock(t, 0)
	if err := stripUserMcpServers(slog.Default()); !errors.Is(err, ErrUserConfigLocked) {
		t.Fatalf("held lock strip = %v, want ErrUserConfigLocked", err)
	}
	if !bytesEqual(readFile(t, userConfigPath()), before) {
		t.Fatal("deferred strip must not write")
	}
	if len(loadManagedMcpState().Names) != 1 {
		t.Fatal("deferred strip must retain ownership for the retry")
	}
}

func TestOnboardingSeedDefersWhileNativeHoldsLock(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	setUserConfigLockBudget(t, 30*time.Millisecond)
	original := []byte("{\"numStartups\": 3}\n")
	if err := os.WriteFile(userConfigPath(), original, 0o600); err != nil {
		t.Fatal(err)
	}
	lockDir := holdNativeLock(t, 0)
	ensureOnboardingState(slog.Default())
	if !bytesEqual(readFile(t, userConfigPath()), original) {
		t.Fatal("held lock must defer the onboarding seed")
	}
	if err := os.Remove(lockDir); err != nil {
		t.Fatal(err)
	}
	ensureOnboardingState(slog.Default())
	var root map[string]any
	if err := json.Unmarshal(readFile(t, userConfigPath()), &root); err != nil {
		t.Fatal(err)
	}
	if root["hasCompletedOnboarding"] != true || root["numStartups"] != float64(3) {
		t.Fatalf("seed after release lost data: %v", root)
	}
}

// nativeSave mimics one Claude Code saveConfigWithLock: take the mkdir lock
// (retrying ELOCKED), re-read under the lock, set one key, temp+rename, rmdir.
func nativeSave(path, key string) error {
	lockDir := path + ".lock"
	deadline := time.Now().Add(10 * time.Second)
	for {
		err := os.Mkdir(lockDir, 0o777)
		if err == nil {
			break
		}
		if !os.IsExist(err) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(200 * time.Microsecond)
	}
	defer os.Remove(lockDir)
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	root := map[string]any{}
	if err := json.Unmarshal(raw, &root); err != nil {
		return err
	}
	root[key] = true
	// Widen the read-to-rename window so an unlocked writer would collide.
	time.Sleep(100 * time.Microsecond)
	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp.native.%s", path, key)
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func TestConcurrentNativeSavesAndManagedMergeLoseNothing(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	setUserConfigLockBudget(t, 5*time.Second)
	path := userConfigPath()
	seed := map[string]any{
		"oauthAccount": map[string]any{"accountUuid": "acct"},
		"mcpServers":   map[string]any{"mine": map[string]any{"command": "user-owned"}},
	}
	raw, _ := json.Marshal(seed)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	const nativeWriters, nativeSaves, managedRounds = 3, 40, 60
	var wg sync.WaitGroup
	errs := make(chan error, nativeWriters*nativeSaves+managedRounds)
	for w := 0; w < nativeWriters; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < nativeSaves; i++ {
				if err := nativeSave(path, fmt.Sprintf("native_%d_%d", w, i)); err != nil {
					errs <- err
				}
			}
		}(w)
	}
	var last map[string]any
	wg.Add(1)
	go func() {
		defer wg.Done()
		for r := 0; r < managedRounds; r++ {
			// Rotate the managed set so adds and retirements both race.
			servers := map[string]any{"clx": map[string]any{"url": "https://fleet.test/mcp", "round": r}}
			if r%2 == 0 {
				servers[fmt.Sprintf("extra_%d", r)] = map[string]any{"url": "https://extra.test"}
			}
			if _, err := applyUserMcpServersResult(servers, slog.Default()); err != nil {
				errs <- fmt.Errorf("managed round %d: %w", r, err)
				continue
			}
			last = servers
		}
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	var root map[string]any
	if err := json.Unmarshal(readFile(t, path), &root); err != nil {
		t.Fatal(err)
	}
	for w := 0; w < nativeWriters; w++ {
		for i := 0; i < nativeSaves; i++ {
			if root[fmt.Sprintf("native_%d_%d", w, i)] != true {
				t.Fatalf("native key native_%d_%d was lost to a wrapper write", w, i)
			}
		}
	}
	if root["oauthAccount"] == nil {
		t.Fatal("oauthAccount lost")
	}
	servers, _ := root["mcpServers"].(map[string]any)
	if servers["mine"] == nil {
		t.Fatal("user-authored MCP server lost")
	}
	want := make([]string, 0, len(last))
	for name := range last {
		want = append(want, name)
		if servers[name] == nil {
			t.Fatalf("managed server %q lost to a native write", name)
		}
	}
	sort.Strings(want)
	if len(servers) != len(want)+1 {
		t.Fatalf("retired managed servers left behind: %v (want %v + mine)", servers, want)
	}
	if got := loadManagedMcpState().Names; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("sidecar %v does not match the last managed set %v", got, want)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude.json.lock")); !os.IsNotExist(err) {
		t.Fatalf("lock left behind: %v", err)
	}
}
