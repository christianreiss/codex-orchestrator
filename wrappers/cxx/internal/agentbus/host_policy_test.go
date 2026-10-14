package agentbus

import (
	"bytes"
	"context"
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func stubWorkerPolicy(t *testing.T, decision workerDecision) {
	t.Helper()
	old := workerPolicy
	t.Cleanup(func() { workerPolicy = old })
	workerPolicy = func() workerDecision { return decision }
}

// docs/host-runtime-policy.md: the per-user worker resumes dormant agents, which
// is remote execution and exists only on a persistent host. Maintenance's
// `agent service install` therefore retires the unit everywhere else.
func TestServiceInstallRetiresWorkerOnNonPersistentHost(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd action is Linux-specific")
	}
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg"))
	calls := stubServiceProcess(t, nil)
	stubWorkerPolicy(t, workerForbidden)
	stubUserManager(t, true)

	// No unit installed: nothing to do, no systemctl call.
	if err := runServiceCommand([]string{"install"}, io.Discard, io.Discard); err != nil || len(*calls) != 0 {
		t.Fatalf("normal host without a unit touched systemd: calls=%v err=%v", *calls, err)
	}

	path, err := servicePath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("legacy"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runServiceCommand([]string{"install"}, io.Discard, io.Discard); err != nil {
		t.Fatalf("retire legacy unit: %v", err)
	}
	want := [][]string{
		{"systemctl", "--user", "disable", "--now", "cxx-agent.service"},
		{"systemctl", "--user", "daemon-reload"},
	}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("retire calls = %v, want %v", *calls, want)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("legacy unit survived on a normal host: %v", err)
	}
	*calls = nil
	if err := runServiceCommand([]string{"start"}, io.Discard, io.Discard); err != nil || len(*calls) != 0 {
		t.Fatalf("start on a normal host did something: calls=%v err=%v", *calls, err)
	}
}

func TestServiceInstallKeepsWorkerOnPersistentHostAndChangesNothingWhenUnknown(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd action is Linux-specific")
	}
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg"))
	calls := stubServiceProcess(t, nil)
	stubLinger(t, "relayuser", false)

	stubWorkerPolicy(t, workerUnknown)
	if err := runServiceCommand([]string{"install"}, io.Discard, io.Discard); err != nil || len(*calls) != 0 {
		t.Fatalf("an unanswered persistence check changed the service: calls=%v err=%v", *calls, err)
	}
	if err := runServiceCommand([]string{"start"}, io.Discard, io.Discard); err == nil {
		t.Fatal("start without confirmed persistence succeeded")
	}

	stubWorkerPolicy(t, workerAllowed)
	if err := runServiceCommand([]string{"install"}, io.Discard, io.Discard); err != nil {
		t.Fatalf("install on a persistent host: %v", err)
	}
	if len(*calls) == 0 || (*calls)[len(*calls)-1][0] != "systemctl" {
		t.Fatalf("persistent host did not get its worker: %v", *calls)
	}
}

func TestHostPersistenceMatchesTheServer(t *testing.T) {
	for _, tc := range []struct {
		s    daemonSettings
		want bool
	}{
		{daemonSettings{}, false},
		{daemonSettings{ResidentEnabled: true}, true},
		{daemonSettings{Enabled: true}, true},
		{daemonSettings{ExecutionRequested: true}, true},
	} {
		if got := hostPersistent(tc.s); got != tc.want {
			t.Fatalf("hostPersistent(%+v) = %v, want %v", tc.s, got, tc.want)
		}
	}
	refused := &APIError{Status: http.StatusServiceUnavailable, Code: "agent_messaging_relay_not_persistent"}
	if !relayNotPersistent(refused) || relayNotPersistent(&APIError{Status: http.StatusServiceUnavailable, Code: "agent_messaging_disabled"}) {
		t.Fatal("relay refusal classification is wrong")
	}
}

// Regression (Eva-Marie, 2026-10-14): a 0.9.82 worker started directly (a
// legacy unit after a binary update) against an API that does not refuse relays
// resumed a dormant agent on a normal host. The worker must gate itself.
func TestWorkerExitsBeforeRelayingOnNonPersistentHost(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	stubWorkerPolicy(t, workerForbidden)
	done := make(chan error, 1)
	var out bytes.Buffer
	go func() { done <- RunWorker(context.Background(), "test", &out, io.Discard) }()
	select {
	case err := <-done:
		if err != nil || !strings.Contains(out.String(), "not persistent") {
			t.Fatalf("RunWorker = %v, output %q", err, out.String())
		}
		if strings.Contains(out.String(), "relay: connected") {
			t.Fatal("worker connected a relay on a normal host")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker kept running on a normal host")
	}
}

func TestWorkerExitsWhenTheHostLosesItsPersistentFlag(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	old, oldRecheck := workerPolicy, workerPolicyRecheck
	t.Cleanup(func() { workerPolicy, workerPolicyRecheck = old, oldRecheck })
	var calls atomic.Int32
	workerPolicy = func() workerDecision {
		if calls.Add(1) == 1 {
			return workerAllowed
		}
		return workerForbidden
	}
	workerPolicyRecheck = 50 * time.Millisecond
	done := make(chan error, 1)
	go func() { done <- RunWorker(context.Background(), "test", io.Discard, io.Discard) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("RunWorker = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker kept running after the persistent flag was removed")
	}
}

// Feedback d69d6e38: persistence belongs to the daemon's account. Another OS
// user on a persistent host (root on biest, whose daemon runs as chris) is a
// normal user and gets no worker.
func TestWorkerPolicyRequiresTheDaemonUser(t *testing.T) {
	persistentForChris := daemonSettings{Enabled: true, Username: "chris"}
	if got := workerDecisionFor(persistentForChris, "chris"); got != workerAllowed {
		t.Fatalf("daemon user decision = %v, want allowed", got)
	}
	for _, user := range []string{"root", ""} {
		if got := workerDecisionFor(persistentForChris, user); got != workerForbidden {
			t.Fatalf("user %q on chris's persistent host = %v, want forbidden", user, got)
		}
	}
	if got := workerDecisionFor(daemonSettings{Username: "chris"}, "chris"); got != workerForbidden {
		t.Fatalf("non-persistent host = %v, want forbidden", got)
	}
}

func stubUserManager(t *testing.T, available bool) {
	t.Helper()
	old := systemdUserManagerAvailable
	t.Cleanup(func() { systemdUserManagerAvailable = old })
	systemdUserManagerAvailable = func() bool { return available }
}

// Feedback 9c1712dd: without a per-user systemd manager (XCP-ng) the unit can
// never have run; retiring it removes the file without calling systemctl.
func TestRetireWithoutUserManagerRemovesTheUnitFile(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd action is Linux-specific")
	}
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg"))
	calls := stubServiceProcess(t, map[string]error{"systemctl": errors.New("Failed to get D-Bus connection")})
	stubWorkerPolicy(t, workerForbidden)
	stubUserManager(t, false)
	path, err := servicePath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("legacy"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runServiceCommand([]string{"install"}, io.Discard, io.Discard); err != nil {
		t.Fatalf("retire without a user manager failed: %v", err)
	}
	if len(*calls) != 0 {
		t.Fatalf("systemctl called without a user manager: %v", *calls)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unit file survived: %v", err)
	}
}

// Feedback 42fe1081: a config that can never run a relay (TLS bypass, plain
// HTTP) is a permanent no, not an unknown to wait out or crash-loop on.
func TestRefusedRelayConfigForbidsTheWorker(t *testing.T) {
	_, err := newRelayClient(&config.Config{Orchestrator: config.Orchestrator{BaseURL: "https://api.example", AllowInsecure: true}})
	if !errors.Is(err, errRelayConfigRefused) {
		t.Fatalf("TLS bypass error = %v, want errRelayConfigRefused", err)
	}
	if got := workerDecisionForError(err); got != workerForbidden {
		t.Fatalf("decision = %v, want forbidden", got)
	}
	if got := workerDecisionForError(errors.New("dial tcp: connection refused")); got != workerUnknown {
		t.Fatalf("network failure decision = %v, want unknown", got)
	}
}

// Feedback d69d6e38: a daemon unit for chris installed by root must use
// chris's configs, not root's.
func TestDaemonUnitUsesTheDaemonAccountsConfigs(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".config", "codex-orchestrator")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cdx.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, ok := daemonAccountConfigPath("/root/.config/codex-orchestrator/cdx.json", "codex", home); !ok || got != filepath.Join(dir, "cdx.json") {
		t.Fatalf("codex path = %q (%v), want the daemon account's", got, ok)
	}
	if _, ok := daemonAccountConfigPath("/root/.config/codex-orchestrator/clx.json", "claude", home); ok {
		t.Fatal("an engine the daemon account has no config for must be skipped")
	}
	inside := filepath.Join(dir, "cdx.json")
	if got, ok := daemonAccountConfigPath(inside, "codex", home); !ok || got != inside {
		t.Fatalf("a path already under the account home changed: %q", got)
	}
}
