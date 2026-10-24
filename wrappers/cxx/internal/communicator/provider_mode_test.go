package communicator_test

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	comm "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"golang.org/x/net/websocket"
)

type ownershipProbe struct{ mode any }

func (p *ownershipProbe) JSON(_ context.Context, _ string, path string, in any, _ any, _ int) error {
	if path == "/auth/sessions" {
		p.mode = in.(map[string]any)["ownership_mode"]
	}
	return nil // Empty credentials stop Start before a native write or state attachment.
}

func TestProviderOwnershipNegotiatedFromSignedCapability(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		for _, required := range []bool{false, true} {
			t.Run(engine+map[bool]string{false: "/legacy", true: "/connection"}[required], func(t *testing.T) {
				base, _, _ := comm.NewCallerRetryOwner(t, func(*websocket.Conn, comm.CallerRetryFrame) {}, http.NotFoundHandler(), false)
				if required {
					comm.SetCallerStateRequired(t, base)
				}
				pool := accountpool.Load(engine, filepath.Join(t.TempDir(), "auth.json"), base)
				pool.Capable = true
				probe := &ownershipProbe{}
				_, _, err := pool.Start(context.Background(), probe, false, func(json.RawMessage, string, bool) (bool, error) {
					t.Fatal("unverified credentials reached native writer")
					return false, nil
				})
				if err == nil {
					t.Fatal("empty assignment accepted")
				}
				if required && probe.mode != "connection" || !required && probe.mode != nil {
					t.Fatalf("required=%v ownership_mode=%v", required, probe.mode)
				}
			})
		}
	}
}
