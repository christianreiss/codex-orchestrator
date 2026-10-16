package agentbus

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path"
	"testing"
)

// The chair's estimate must reach the API untouched; a dropped field would make
// the server fall back to its 900-second default (feedback bee63f6f).
func TestConferenceDispatchForwardsEtaSeconds(t *testing.T) {
	for _, tc := range []struct {
		name string
		args map[string]any
		want any
	}{
		{"explicit", map[string]any{"conference_id": "room", "to": "peer", "task": "go", "eta_seconds": float64(30)}, float64(30)},
		{"omitted", map[string]any{"conference_id": "room", "to": "peer", "task": "go"}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			var op string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				op = path.Base(req.URL.Path)
				_ = json.NewDecoder(req.Body).Decode(&body)
				_ = json.NewEncoder(w).Encode(map[string]any{"eta_seconds": body["eta_seconds"]})
			}))
			defer server.Close()
			c := &sessionClient{id: "session", http: &http.Client{Transport: rewriteTransport{server: server}}}
			if _, err := callMCPTool(context.Background(), c, newChannelTracker(c), "agent_conf_dispatch", tc.args); err != nil {
				t.Fatal(err)
			}
			if op != "dispatch" {
				t.Fatalf("posted to %q", op)
			}
			got, present := body["eta_seconds"]
			if tc.want == nil {
				if present {
					t.Fatalf("omitted eta_seconds was sent as %v", got)
				}
				return
			}
			if got != tc.want {
				t.Fatalf("eta_seconds = %v, want %v", got, tc.want)
			}
		})
	}
}
