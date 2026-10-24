package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestRelayAdvertisesConfiguredStateProtocol(t *testing.T) {
	for _, protocol := range []int{0, 1} {
		t.Run(string(rune('0'+protocol)), func(t *testing.T) {
			registrations, claims := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/host/agent-relays/register" {
					claims++
					t.Error("state-required relay fell back to HTTP polling")
					w.WriteHeader(500)
					return
				}
				registrations++
				var body struct {
					Capabilities map[string]any `json:"capabilities"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				value, present := body.Capabilities["control_state_protocol"]
				if protocol == 1 && (!present || value != float64(1)) {
					t.Errorf("missing negotiated protocol: %v", body.Capabilities)
				}
				if protocol == 0 && present {
					t.Errorf("legacy configuration advertised state protocol: %v", value)
				}
				io.WriteString(w, `{"relay_id":"55555555-5555-4555-8555-555555555555","relay_token":"token","generation":1}`)
			}))
			defer server.Close()
			client, err := newRelayClient(&config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key", CommunicatorStateProtocol: protocol}})
			if err != nil {
				t.Fatal(err)
			}
			registration, err := client.register(context.Background(), "user", "44444444-4444-4444-8444-444444444444", "test")
			if err != nil {
				t.Fatal(err)
			}
			client.id, client.token = registration.RelayID, registration.RelayToken
			if protocol == 1 {
				if err := client.pollParallel(context.Background(), nil, io.Discard, 1); err == nil {
					t.Fatal("missing required state transport accepted")
				}
			}
			if registrations != 1 || claims != 0 {
				t.Fatalf("registration=%d claims=%d", registrations, claims)
			}
		})
	}
}
