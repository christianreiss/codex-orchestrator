package agentbus

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
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
