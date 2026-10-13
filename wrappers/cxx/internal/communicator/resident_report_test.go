package communicator

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
	"golang.org/x/net/websocket"
)

func TestResidentReportRequiresNegotiatedIdentityAndSignedRuntime(t *testing.T) {
	for _, tt := range []struct {
		name    string
		control []string
		runtime bool
		want    bool
	}{
		{"old-server", nil, true, false},
		{"terminate-only", []string{controlTerminate, controlResidentRuntime}, true, false},
		{"identity-only", []string{controlTerminate, controlOwnerIdentity}, true, false},
		{"runtime-disabled", []string{controlTerminate, controlOwnerIdentity, controlResidentRuntime}, false, false},
		{"negotiated", []string{controlTerminate, controlOwnerIdentity, controlResidentRuntime}, true, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got := make(chan json.RawMessage, 8)
			remote := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
				defer ws.Close()
				var hello map[string]any
				if websocket.JSON.Receive(ws, &hello) != nil {
					return
				}
				_ = websocket.JSON.Send(ws, frame{Type: "ready", Protocol: Protocol, Control: tt.control})
				for {
					var raw json.RawMessage
					if websocket.JSON.Receive(ws, &raw) != nil {
						return
					}
					got <- raw
				}
			}))
			t.Cleanup(remote.Close)
			ws, err := websocket.Dial("ws"+strings.TrimPrefix(remote.URL, "http"), "", remote.URL)
			if err != nil {
				t.Fatal(err)
			}
			s := &server{}
			if tt.runtime {
				s.residentState = &residentState{managed: true}
			}
			c := &connection{ws: ws, ready: make(chan struct{}), done: make(chan struct{}), residentReport: s.residentReport}
			go c.receive()
			t.Cleanup(func() { ws.Close(); <-c.done })
			if err := c.send(map[string]any{"type": "hello"}); err != nil {
				t.Fatal(err)
			}
			select {
			case <-c.ready:
			case <-time.After(3 * time.Second):
				t.Fatal("handshake timeout")
			}
			if announces(tt.control, controlTerminate) {
				var raw json.RawMessage
				select {
				case raw = <-got:
				case <-time.After(3 * time.Second):
					t.Fatal("capabilities missing")
				}
				var caps map[string]any
				if err := json.Unmarshal(raw, &caps); err != nil {
					t.Fatal(err)
				}
				if caps["type"] != "capabilities" {
					t.Fatalf("identity must precede diagnostics: %s", raw)
				}
				allowed := map[string]bool{"type": true, "terminate": true, "pid": true, "started_at": true}
				if announces(tt.control, controlOwnerIdentity) {
					allowed["instance_id"], allowed["runtime_id"] = true, true
				}
				for field := range caps {
					if !allowed[field] {
						t.Fatalf("legacy schema got unknown field %s", field)
					}
				}
			}
			if tt.want {
				select {
				case raw := <-got:
					var report residentReport
					if err := json.Unmarshal(raw, &report); err != nil {
						t.Fatal(err)
					}
					if report.Type != "resident_status" || report.OwnerInstanceID != processInstance || report.Mode != "on_demand" || report.Sequence != 1 {
						t.Fatalf("incorrect report: %s", raw)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("negotiated report missing")
				}
				s.resident.Store(true)
				if err := c.sendResidentReport(); err != nil {
					t.Fatal(err)
				}
				select {
				case raw := <-got:
					var report residentReport
					if err := json.Unmarshal(raw, &report); err != nil {
						t.Fatal(err)
					}
					if report.Mode != "resident" || report.Sequence != 2 {
						t.Fatalf("report did not refresh: %s", raw)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("updated report missing")
				}
			} else {
				if err := c.sendResidentReport(); err != nil {
					t.Fatal(err)
				}
				select {
				case raw := <-got:
					t.Fatalf("unnegotiated report: %s", raw)
				case <-time.After(100 * time.Millisecond):
				}
			}
		})
	}
}

func TestResidentReportBoundsCountsAndOmitsSensitiveErrors(t *testing.T) {
	c := &fakeResidentController{status: residency.ExecutionStatus{Running: true, Verified: false, Error: "secret-token", Workload: residency.Workload{Accepted: 2, Receipts: 3, Requests: 2_000_000, Writes: -1}}}
	s := &server{residentState: &residentState{managed: true, policy: residentPolicy{ResidentEnabled: true}, controller: c, pending: 4, legacyClients: 1, lastError: "secret-path"}}
	s.resident.Store(true)
	s.draining.Store(true)
	r := s.residentReport()
	if r.Mode != "resident" || r.Execution == nil || r.Execution.Workload.Requests != 1_000_000 || r.Execution.Workload.Writes != 0 || !r.Draining || len(r.BinarySHA256) != 64 {
		t.Fatalf("incorrect bounded report: %+v", r)
	}
	raw, err := json.Marshal(r)
	if err != nil || strings.Contains(string(raw), "secret") || len(raw) > 4096 {
		t.Fatalf("unbounded or sensitive report: %s, %v", raw, err)
	}
	if s.preflightStop() == "" {
		t.Fatal("an unverified active controller must still refuse stop")
	}
}
