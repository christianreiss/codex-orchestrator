package agentbus

import (
	"bytes"
	"context"
	"errors"
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
