package agentbus

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// Feedback 845ba7f6: an unreadable (root-owned layout) or expired config is a
// stale config, not an unknown to wait out forever.
func TestUnusableConfigIsStaleNotUnknown(t *testing.T) {
	eacces := fmt.Errorf("codex: %w", fmt.Errorf("read config: %w", &fs.PathError{Op: "open", Path: "/x/cdx.json", Err: syscall.EACCES}))
	expired := errors.Join(fmt.Errorf("claude: %w", &config.ExpiredError{ExpiresAt: time.Now().Add(-time.Hour)}))
	for name, err := range map[string]error{"eacces": eacces, "expired": expired, "joined": errors.Join(eacces, expired)} {
		if got := workerDecisionForError(err); got != workerStaleConfig {
			t.Fatalf("%s decision = %v, want stale", name, got)
		}
	}
	if got := workerDecisionForError(errors.New("dial tcp: connection refused")); got != workerUnknown {
		t.Fatalf("network failure decision = %v, want unknown", got)
	}
	if got := workerDecisionForError(errors.New("no signed messaging-enabled engine config available")); got != workerForbidden {
		t.Fatalf("missing config decision = %v, want forbidden", got)
	}
}

func TestStaleConfigClockResetsOnRecovery(t *testing.T) {
	old := workerStaleConfigGrace
	t.Cleanup(func() { workerStaleConfigGrace = old })
	workerStaleConfigGrace = time.Minute
	var c staleConfigClock
	start := time.Now()
	if c.observe(true, start) || c.observe(true, start.Add(59*time.Second)) {
		t.Fatal("grace ended early")
	}
	if c.observe(false, start.Add(60*time.Second)) || c.observe(true, start.Add(61*time.Second)) {
		t.Fatal("a usable config did not reset the grace")
	}
	if !c.observe(true, start.Add(121*time.Second)) {
		t.Fatal("grace did not end")
	}
}

func shortStaleGrace(t *testing.T) {
	t.Helper()
	oldGrace, oldRetry, oldRecheck := workerStaleConfigGrace, workerConfigRetry, workerPolicyRecheck
	t.Cleanup(func() {
		workerStaleConfigGrace, workerConfigRetry, workerPolicyRecheck = oldGrace, oldRetry, oldRecheck
	})
	workerStaleConfigGrace, workerConfigRetry = 60*time.Millisecond, 10*time.Millisecond
}

func runWorkerUntilExit(t *testing.T) string {
	t.Helper()
	done := make(chan error, 1)
	var out bytes.Buffer
	go func() { done <- RunWorker(context.Background(), "test", &out, io.Discard) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("RunWorker = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker kept spinning on an unusable config")
	}
	return out.String()
}

func TestWorkerExitsWhenItsConfigStaysUnusableAtStart(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	shortStaleGrace(t)
	stubWorkerPolicy(t, workerStaleConfig)
	if out := runWorkerUntilExit(t); !strings.Contains(out, "stays unusable") || strings.Contains(out, "starting") {
		t.Fatalf("output %q", out)
	}
}

func TestWorkerExitsWhenItsConfigBecomesUnusableWhileRunning(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	shortStaleGrace(t)
	workerPolicyRecheck = time.Hour // only the relay loop sees the failure
	stubWorkerPolicy(t, workerAllowed)
	old := workerLoadConfigs
	t.Cleanup(func() { workerLoadConfigs = old })
	workerLoadConfigs = func() (map[string]*config.Config, *config.Config, error) {
		return nil, nil, fmt.Errorf("codex: read config: %w", &fs.PathError{Op: "open", Path: "/x", Err: syscall.EACCES})
	}
	if out := runWorkerUntilExit(t); !strings.Contains(out, "stays unusable") {
		t.Fatalf("output %q", out)
	}
}

func TestWorkerPolicyRecheckEndsAWorkerOnAStaleConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	shortStaleGrace(t)
	workerPolicyRecheck = 10 * time.Millisecond
	old := workerPolicy
	t.Cleanup(func() { workerPolicy = old })
	var calls atomic.Int32
	workerPolicy = func() workerDecision {
		if calls.Add(1) == 1 {
			return workerAllowed
		}
		return workerStaleConfig
	}
	runWorkerUntilExit(t)
}

// fakeSweepRoot builds /etc/passwd, /proc and homes under a temp root.
func fakeSweepRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, body string) {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("etc/passwd", "root:x:0:0:root:/root:/bin/sh\nchris:x:1000:1000::/home/chris:/bin/sh\nbob:x:1001:1001::/home/bob:/bin/sh\n")
	proc := func(pid, uid int, argv ...string) {
		write(fmt.Sprintf("proc/%d/cmdline", pid), strings.Join(argv, "\x00")+"\x00")
		write(fmt.Sprintf("proc/%d/status", pid), fmt.Sprintf("Name:\tcxx\nUid:\t%d\t%d\t%d\t%d\n", uid, uid, uid, uid))
	}
	proc(100, 1000, "/home/chris/.local/bin/cxx (deleted)", "agent", "worker", "--foreground")
	proc(101, 1001, "/usr/local/bin/cxx", "agent", "worker", "--foreground")
	proc(102, 0, "/usr/local/bin/cxx", "agent", "worker", "--foreground")
	proc(103, 1001, "/usr/bin/vim", "agent", "worker", "--foreground")
	proc(104, 1001, "/usr/local/bin/cxx", "daemon", "run")
	unit := "[Service]\nExecStart=\"/usr/local/bin/cxx\" agent worker --foreground\nRestart=on-failure\n"
	for _, user := range []string{"chris", "bob"} {
		write("home/"+user+"/.config/systemd/user/cxx-agent.service", unit)
		link := filepath.Join(root, "home", user, ".config/systemd/user/default.target.wants/cxx-agent.service")
		if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("../cxx-agent.service", link); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func stubSweep(t *testing.T, root string, settings daemonSettings, known bool) *[]int {
	t.Helper()
	oldRoot, oldEnabled, oldPolicy, oldSignal := foreignSweepRoot, foreignSweepEnabled, foreignSweepPolicy, signalWorker
	t.Cleanup(func() {
		foreignSweepRoot, foreignSweepEnabled, foreignSweepPolicy, signalWorker = oldRoot, oldEnabled, oldPolicy, oldSignal
	})
	var signalled []int
	foreignSweepRoot = root
	foreignSweepEnabled = func() bool { return true }
	foreignSweepPolicy = func() (daemonSettings, bool) { return settings, known }
	signalWorker = func(pid int) error { signalled = append(signalled, pid); return nil }
	return &signalled
}

func unitExists(t *testing.T, root, user string) bool {
	t.Helper()
	_, err := os.Lstat(filepath.Join(root, "home", user, ".config/systemd/user/cxx-agent.service"))
	_, linkErr := os.Lstat(filepath.Join(root, "home", user, ".config/systemd/user/default.target.wants/cxx-agent.service"))
	if (err == nil) != (linkErr == nil) {
		t.Fatalf("%s: unit and enablement link disagree: %v / %v", user, err, linkErr)
	}
	return err == nil
}

func TestRootRetiresOtherAccountsWorkersOnNonPersistentHost(t *testing.T) {
	root := fakeSweepRoot(t)
	signalled := stubSweep(t, root, daemonSettings{}, true)
	retireForeignWorkers(io.Discard)
	sort.Ints(*signalled)
	if want := []int{100, 101}; !reflect.DeepEqual(*signalled, want) {
		t.Fatalf("signalled %v, want %v (root, non-cxx and daemon processes untouched)", *signalled, want)
	}
	if unitExists(t, root, "chris") || unitExists(t, root, "bob") {
		t.Fatal("legacy user units survived on a non-persistent host")
	}
}

func TestRootKeepsTheDaemonAccountsWorkerOnPersistentHost(t *testing.T) {
	root := fakeSweepRoot(t)
	signalled := stubSweep(t, root, daemonSettings{Enabled: true, Username: "chris"}, true)
	retireForeignWorkers(io.Discard)
	if want := []int{101}; !reflect.DeepEqual(*signalled, want) {
		t.Fatalf("signalled %v, want %v", *signalled, want)
	}
	if !unitExists(t, root, "chris") || unitExists(t, root, "bob") {
		t.Fatal("persistent host: chris's unit must stay, bob's must go")
	}
}

func TestRootSweepChangesNothingWithoutAnAnswer(t *testing.T) {
	for name, tc := range map[string]struct {
		settings daemonSettings
		known    bool
	}{
		"unknown":           {daemonSettings{}, false},
		"unresolvable user": {daemonSettings{Enabled: true, Username: "ghost"}, true},
	} {
		root := fakeSweepRoot(t)
		signalled := stubSweep(t, root, tc.settings, tc.known)
		retireForeignWorkers(io.Discard)
		if len(*signalled) != 0 || !unitExists(t, root, "chris") || !unitExists(t, root, "bob") {
			t.Fatalf("%s: sweep acted: %v", name, *signalled)
		}
	}
}

func TestRootSweepLeavesForeignUnitsAlone(t *testing.T) {
	root := fakeSweepRoot(t)
	path := filepath.Join(root, "home/bob/.config/systemd/user/cxx-agent.service")
	if err := os.WriteFile(path, []byte("[Service]\nExecStart=/usr/bin/something\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stubSweep(t, root, daemonSettings{}, true)
	retireForeignWorkers(io.Discard)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("a unit not written by cxx was removed: %v", err)
	}
}
