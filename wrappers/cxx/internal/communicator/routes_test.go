package communicator

import (
	"net/http/httptest"
	"testing"
)

func TestManagedRequestAllowedAccountRoutes(t *testing.T) {
	for _, path := range []string{
		"/auth",
		"/auth/accounts?engine=claude&session_id=abc",
		"/auth/sessions",
		"/auth/sessions/heartbeat",
		"/auth/sessions/release",
		"/auth/sessions/switch",
		"/auth/sessions/switch-request",
		"/claude/usage/report",
	} {
		if !managedRequestAllowed(httptest.NewRequest("GET", path, nil)) {
			t.Errorf("%s must be tunnelled", path)
		}
	}
	for _, path := range []string{
		"/auth/accounts/1",
		"/auth/sessions/switchx",
		"/auth/sessions/switch/../../admin",
		"/admin/accounts",
	} {
		if managedRequestAllowed(httptest.NewRequest("GET", path, nil)) {
			t.Errorf("%s must be refused", path)
		}
	}
}
