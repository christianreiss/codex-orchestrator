package agentbus

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestResidentServiceIntentSurvivesMigrationFenceWithoutRenewingExpiry(t *testing.T) {
	// The API deliberately masks effective execution while migration holds
	// admission. The service must still be reconciled/recovered for that intent.
	if !residentRequested(daemonSettings{ExecutionRequested: true}, true) {
		t.Fatal("fenced execution-only service cannot resume its migration")
	}
	if residentRequested(daemonSettings{ExecutionRequested: true, ExpiresAt: "2000-01-01T00:00:00Z"}, true) {
		t.Fatal("expired execution intent revived residence")
	}
	if !residentRequested(daemonSettings{ResidentEnabled: true, ExpiresAt: "2000-01-01T00:00:00Z"}, true) {
		t.Fatal("expiry cleared explicit residence")
	}
	if residentRequested(daemonSettings{}, true) {
		t.Fatal("default settings implicitly enabled residence")
	}
	if residentRequested(daemonSettings{ResidentEnabled: true, ExecutionRequested: true}, false) {
		t.Fatal("unsigned residency intent installed a legacy daemon")
	}
	if !residentRequested(daemonSettings{Enabled: true}, false) {
		t.Fatal("legacy execution service lost compatibility")
	}
}

func TestLaunchdServiceDomainWithoutGUIAndLegacyJobs(t *testing.T) {
	old := launchdServiceLoaded
	t.Cleanup(func() { launchdServiceLoaded = old })
	for _, tc := range []struct {
		name      string
		user, gui bool
		want      string
	}{
		{"headless install", false, false, "user/501"},
		{"existing background", true, false, "user/501"},
		{"legacy GUI", false, true, "gui/501"},
		{"background takes precedence", true, true, "user/501"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			launchdServiceLoaded = func(target string) bool {
				if target == "user/501/"+launchLabel {
					return tc.user
				}
				if target == "gui/501/"+launchLabel {
					return tc.gui
				}
				t.Fatalf("unexpected target %q", target)
				return false
			}
			if got := launchdServiceDomain(501); got != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
}

func TestLaunchAgentAllowsBackgroundAndGUIBootstrap(t *testing.T) {
	body := renderLaunchAgent("/usr/local/bin/cxx", "digest", nil)
	if !strings.Contains(body, "<key>LimitLoadToSessionType</key><array><string>Background</string><string>Aqua</string></array>") {
		t.Fatal("LaunchAgent cannot bootstrap in both user and legacy GUI domains")
	}
}

func TestWaitLaunchdRemovalBeforeBootstrap(t *testing.T) {
	old := launchdUnitMissing
	t.Cleanup(func() { launchdUnitMissing = old })
	calls := 0
	launchdUnitMissing = func(string) (bool, error) { calls++; return calls == 3, nil }
	if err := waitLaunchdUnitRemoved("user/501/job", time.Second, 0); err != nil || calls != 3 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
	launchdUnitMissing = func(string) (bool, error) { return false, nil }
	if err := waitLaunchdUnitRemoved("user/501/job", 0, 0); err == nil {
		t.Fatal("accepted still-loaded job")
	}
	denied := errors.New("permission denied")
	launchdUnitMissing = func(string) (bool, error) { return false, denied }
	if err := waitLaunchdUnitRemoved("user/501/job", time.Second, 0); !errors.Is(err, denied) {
		t.Fatalf("probe error lost: %v", err)
	}
}
