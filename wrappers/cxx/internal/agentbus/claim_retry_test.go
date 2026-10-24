package agentbus

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestClaimStatusRetriesOnlyTransientSafeReads(t *testing.T) {
	for _, tc := range []struct {
		suffix, code string
		status       int
		response     bool
		want         int
	}{
		{"claims/status", "communicator_unavailable", 502, false, 3},
		{"claims/status", "communicator_unavailable", 503, false, 3},
		{"claims/status", "api_disabled", 503, false, 1},
		{"claims/status", "forbidden", 403, false, 1},
		{"claims/status", "communicator_unavailable", 502, true, 1},
		{"claims/acquire", "communicator_unavailable", 502, false, 1},
	} {
		t.Run(tc.suffix+tc.code, func(t *testing.T) {
			calls := 0
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				calls++
				if calls == 3 {
					return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"state":"active"}`)), Header: http.Header{}}, nil
				}
				return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(`{"code":"` + tc.code + `","message":"temporary"}`)), Header: http.Header{}}, nil
			})}}
			args := map[string]any{"claim_id": "claim", "renew": true}
			if tc.response {
				args["response"] = "wait"
			}
			var out map[string]any
			err := client.post(context.Background(), tc.suffix, args, &out)
			if calls != tc.want {
				t.Fatalf("calls=%d, want=%d", calls, tc.want)
			}
			if tc.want == 3 && (err != nil || out["state"] != "active") {
				t.Fatalf("renewal recovery: %v %v", out, err)
			}
		})
	}
}
