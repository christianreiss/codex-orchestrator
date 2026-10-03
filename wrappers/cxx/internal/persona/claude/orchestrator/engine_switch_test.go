package orchestrator

import (
	"context"
	"net/http"
	"testing"
	"time"
)

const (
	fleetDisabledReason = "Claude is disabled fleet-wide by the administrator."
	hostDisabledReason  = "Claude is disabled for this host by the administrator."
	apiDisabledReason   = "Auth API disabled by administrator."
)

// TestDecidePinsEngineSwitchRefusals pins the exact operator-facing texts:
// the fleet master switch, host-level removal, and the API kill switch are
// three different administrator decisions and must never share wording.
// None of them may fall back to cached credentials.
func TestDecidePinsEngineSwitchRefusals(t *testing.T) {
	fresh := LocalAuthProbe{
		IsValid: func(string) bool { return true },
		IsFresh: func(string, time.Duration) (bool, error) { return true, nil },
	}
	for _, tc := range []struct {
		name       string
		resp       *AuthRetrieveResponse
		wantStatus string
		wantReason string
	}{
		{name: "fleet switch via /auth", resp: &AuthRetrieveResponse{Status: AuthStatusSuspended}, wantStatus: AuthStatusSuspended, wantReason: fleetDisabledReason},
		{name: "host removal via /auth", resp: &AuthRetrieveResponse{Status: AuthStatusDisabled}, wantStatus: AuthStatusDisabled, wantReason: hostDisabledReason},
		{
			name:       "fleet body folded into an offline sentinel",
			resp:       &AuthRetrieveResponse{Status: "offline", Message: `POST /sync/bootstrap -> 403: {"status":"error","message":"Claude is disabled fleet-wide by the administrator","code":"engine_disabled","scope":"fleet","engine":"claude"}`},
			wantStatus: AuthStatusSuspended,
			wantReason: fleetDisabledReason,
		},
		{
			name:       "scopeless body from an older server means the host",
			resp:       &AuthRetrieveResponse{Status: "offline", Message: `POST /sync/bootstrap -> 403: {"status":"error","code":"engine_disabled"}`},
			wantStatus: AuthStatusDisabled,
			wantReason: hostDisabledReason,
		},
		{
			name:       "API kill switch keeps its own text",
			resp:       &AuthRetrieveResponse{Status: "valid", Versions: &VersionSummary{APIDisabled: true}},
			wantStatus: "valid",
			wantReason: apiDisabledReason,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Decide(tc.resp, "/tmp/auth.json", true, fresh)
			if got.Allowed || got.LocalUsable {
				t.Fatalf("refusal launched: %+v", got)
			}
			if got.Status != tc.wantStatus || got.Reason != tc.wantReason {
				t.Fatalf("Decide = status %q reason %q, want %q %q", got.Status, got.Reason, tc.wantStatus, tc.wantReason)
			}
		})
	}
}

// TestAuthRetrieveMapsEngineDisabledScope: the 403 body's scope selects the
// synthetic status, and a body without one keeps the historical host meaning.
func TestAuthRetrieveMapsEngineDisabledScope(t *testing.T) {
	for _, tc := range []struct {
		name, body, wantStatus string
	}{
		{name: "fleet", body: `{"status":"error","message":"off","code":"engine_disabled","scope":"fleet","engine":"claude"}`, wantStatus: AuthStatusSuspended},
		{name: "host", body: `{"status":"error","message":"off","code":"engine_disabled","scope":"host","engine":"claude"}`, wantStatus: AuthStatusDisabled},
		{name: "scopeless", body: `{"status":"error","message":"off","code":"engine_disabled"}`, wantStatus: AuthStatusDisabled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(tc.body))
			})
			resp, err := c.AuthRetrieve(context.Background(), "")
			if err != nil {
				t.Fatalf("a policy refusal is an answer, not an error: %v", err)
			}
			if resp.Status != tc.wantStatus {
				t.Fatalf("status = %q, want %q", resp.Status, tc.wantStatus)
			}
		})
	}
}

func TestEngineDisabledStatusFromErrorIgnoresOtherRefusals(t *testing.T) {
	for _, err := range []error{
		nil,
		&HTTPError{StatusCode: http.StatusForbidden, Code: "insecure_denied", Scope: "fleet"},
		&HTTPError{StatusCode: http.StatusServiceUnavailable, Code: "api_disabled"},
	} {
		if got := EngineDisabledStatusFromError(err); got != "" {
			t.Fatalf("EngineDisabledStatusFromError(%v) = %q, want empty", err, got)
		}
	}
	if got := EngineDisabledStatusFromError(&HTTPError{StatusCode: http.StatusForbidden, Code: "engine_disabled", Scope: "fleet"}); got != AuthStatusSuspended {
		t.Fatalf("fleet scope = %q", got)
	}
}
