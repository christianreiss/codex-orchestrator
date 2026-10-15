//go:build linux

package agentportal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeprocess"
)

func TestNativeControlRoundTripForEveryEngine(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			var exits atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("x-agent-bridge-token") != "fixture-token" {
					t.Error("missing session authentication")
				}
				var body struct {
					Instance string `json:"instance_id"`
					Report   *struct {
						Status string `json:"status"`
					} `json:"report"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				if body.Report != nil && body.Report.Status == "exited" {
					exits.Add(1)
				}
				json.NewEncoder(w).Encode(map[string]any{"instance_id": body.Instance, "request_id": "11111111-1111-4111-8111-111111111111"})
			}))
			defer server.Close()
			session := &Session{ID: "22222222-2222-4222-8222-222222222222", BridgeToken: "fixture-token", BaseURL: server.URL, Engine: engine, http: server.Client()}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			ctx = session.withNativeControl(ctx)
			cmd := exec.CommandContext(ctx, "sleep", "30")
			supervisor := nativeprocess.Prepare(ctx, cmd, true)
			defer supervisor.Close()
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			supervisor.StartControl()
			_ = cmd.Wait()
			supervisor.Close()
			if ctx.Err() == nil {
				t.Fatal("operator stop did not cancel launch retries")
			}
			if exits.Load() != 1 {
				t.Fatalf("exit receipts: %d", exits.Load())
			}
		})
	}
}
