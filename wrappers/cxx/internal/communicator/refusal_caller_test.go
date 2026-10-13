package communicator_test

import (
	"errors"
	"testing"

	comm "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	claude "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	codex "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// A 5xx that outlives the retries comes back from Do as an error, from JSON as an
// HTTPError, and as a response only below 500; read the verdict from whichever.
func verdictOf(status int, code string, err error) (int, string) {
	if status != 0 {
		return status, code
	}
	var ce *codex.HTTPError
	var ae *claude.HTTPError
	switch {
	case errors.As(err, &ce):
		return ce.StatusCode, ce.Code
	case errors.As(err, &ae):
		return ae.StatusCode, ae.Code
	}
	return 0, ""
}

// Direct HTTPS answered a revoked key or an unbound IP with 401/403, which the
// wrappers' own clients return at once (4xx is never retried) and classify as a
// verdict on the host. Through the owner the same answer must survive, while an
// outage stays a 5xx the clients retry and bridge with cached auth.
func TestCallerSeesTheServersHostVerdictThroughTheOwner(t *testing.T) {
	const ipMismatch = `{"status":"error","message":"API key not allowed from this IP","code":"ip_mismatch"}`
	for _, engine := range []string{"codex", "claude"} {
		for _, entry := range []string{"JSON", "Do"} {
			for _, tc := range []struct {
				name           string
				status         int
				code, body     string
				wantStatus     int
				wantCode       string
				wantLocalCalls int32
			}{
				{"ip binding", 401, "ip_mismatch", ipMismatch, 401, "ip_mismatch", 1},
				{"revoked key", 401, "invalid_api_key", `{"status":"error","message":"Invalid API key","code":"invalid_api_key"}`, 401, "invalid_api_key", 1},
				{"disabled host", 403, "host_disabled", `{"status":"error","message":"Host disabled","code":"host_disabled"}`, 403, "host_disabled", 1},
				{"communicator off is not a host verdict", 403, "communicator_disabled", `{"code":"communicator_disabled"}`, 503, "communicator_unavailable", 3},
				{"kill switch is not a host verdict", 403, "api_disabled", `{"code":"api_disabled"}`, 503, "communicator_unavailable", 3},
				{"plain outage", 0, "", "", 503, "communicator_unavailable", 3},
			} {
				t.Run(engine+"/"+entry+"/"+tc.name, func(t *testing.T) {
					base, local := comm.NewRefusedOwner(t, tc.status, tc.code, tc.body)
					status, code, err := callWithRetries(t, newRetryCaller(t, engine, base), entry, base, "/auth", `{"command":"retrieve"}`)
					status, code = verdictOf(status, code, err)
					if status != tc.wantStatus || code != tc.wantCode {
						t.Fatalf("status=%d code=%q err=%v, want %d %q", status, code, err, tc.wantStatus, tc.wantCode)
					}
					if local.Load() != tc.wantLocalCalls {
						t.Fatalf("client made %d calls to the owner, want %d (4xx is terminal, 5xx is retried)", local.Load(), tc.wantLocalCalls)
					}
				})
			}
		}
	}
}
