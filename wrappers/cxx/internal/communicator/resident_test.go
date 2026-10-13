package communicator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
	"golang.org/x/net/websocket"
)

type fakeResidentController struct {
	status residency.ExecutionStatus
	fenced bool
}

func (c *fakeResidentController) Run(context.Context, residency.ExecutionTransport) error { return nil }
func (c *fakeResidentController) Fence()                                                  { c.fenced = true }
func (c *fakeResidentController) ResumeAdmission()                                        { c.fenced = false }
func (c *fakeResidentController) Status() residency.ExecutionStatus                       { return c.status }

func TestResidentPreflightRefusesOutstandingExecutionAndFiniteWork(t *testing.T) {
	for _, work := range []residency.Workload{{Accepted: 1}, {PeerClaims: 1}, {Children: 1}, {Receipts: 1}, {Writes: 1}} {
		controller := &fakeResidentController{status: residency.ExecutionStatus{Verified: true, Workload: work}}
		s := &server{residentState: &residentState{controller: controller}}
		if reason := s.preflightStop(); reason != "execution_busy" {
			t.Fatalf("unsafe stop %+v: %s", work, reason)
		}
		if s.draining.Load() || controller.fenced {
			t.Fatal("refused stop stranded admission")
		}
	}
	s := &server{residentState: &residentState{}, scopes: map[string]*scopeState{"busy": {running: true}}}
	if reason := s.preflightStop(); reason != "sync_busy" {
		t.Fatalf("worker ignored: %s", reason)
	}
	s.scopes = nil
	s.residentState.legacyClients = 1
	if reason := s.preflightStop(); reason != "clients_busy" {
		t.Fatalf("legacy client ignored: %s", reason)
	}
	s.residentState.legacyClients = 0
	if reason := s.preflightStop(); reason != "" || !s.draining.Load() {
		t.Fatalf("quiet handoff refused: %s", reason)
	}
}

func TestResidentDirectDaemonChannelPreservesSharedConnection(t *testing.T) {
	c := testConnection(t, func(ws *websocket.Conn, f frame) {
		if f.Type == "daemon" {
			var request map[string]any
			json.Unmarshal(f.Payload, &request)
			body, _ := json.Marshal(map[string]any{"id": request["id"], "result": map[string]bool{"accepted": true}})
			websocket.JSON.Send(ws, frame{Type: "daemon_event", Payload: body})
		} else if f.Type == "request" {
			websocket.JSON.Send(ws, frame{ID: f.ID, Status: 200, Body: []byte("shared")})
		}
	})
	s := &server{cfg: &config.Config{Orchestrator: config.Orchestrator{BaseURL: "https://resident.example", CommunicatorProtocol: 1}}, conn: c, residentState: &residentState{}}
	transport := residentExecutionTransport{s}
	stream, err := transport.OpenDaemon(context.Background(), "https://resident.example")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transport.OpenDaemon(context.Background(), "https://resident.example"); err == nil {
		t.Fatal("second daemon attached")
	}
	if err := stream.Send(map[string]any{"id": "original", "type": "accept"}); err != nil {
		t.Fatal(err)
	}
	var result struct {
		ID     string
		Result struct{ Accepted bool }
	}
	if err := stream.Receive(&result); err != nil || result.ID != "original" || !result.Result.Accepted {
		t.Fatalf("frame changed: %+v %v", result, err)
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	reply, _, err := c.request(context.Background(), frame{Method: "GET", Path: "/versions"})
	if err != nil || string(reply.Body) != "shared" {
		t.Fatalf("daemon close killed transport: %v", err)
	}
	second, err := transport.OpenDaemon(context.Background(), "https://resident.example")
	if err != nil {
		t.Fatal(err)
	}
	second.Close()
}

func TestResidentAdmissionCountsRequestsBeforeDispatch(t *testing.T) {
	s := &server{residentState: &residentState{}, cfg: &config.Config{}, jobs: map[string]syncJob{}, jobRefs: map[string]int{}}
	s.draining.Store(true)
	response := httptest.NewRecorder()
	residentHandler{s}.ServeHTTP(response, httptest.NewRequest("POST", "/_comm/sync", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatal(response.Code)
	}
	if s.residentState.pending != 0 {
		t.Fatal("refused request counted as accepted")
	}
	if _, err := (residentExecutionTransport{s}).OpenDaemon(context.Background(), "https://other.example"); err == nil {
		t.Fatal("other server admitted")
	}
	var _ io.Closer = (*residentDaemonStream)(nil)
}
