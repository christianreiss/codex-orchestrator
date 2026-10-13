package agentbus

import "testing"

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
