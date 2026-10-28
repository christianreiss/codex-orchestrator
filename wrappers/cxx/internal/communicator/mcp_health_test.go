package communicator

import (
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Feedback e099e458: status showed connected:true while every MCP call got
// 401, because the transport and the per-frame MCP bearer are authenticated
// separately. Status must report what forwarded MCP calls experienced, and
// doctor must fail while the newest one was refused.
func TestStatusReportsMCPRefusalWhileTransportIsConnected(t *testing.T) {
	f := newMCPFixture(t)
	c := f.start("claude")
	c.send(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if line, ok := c.next(t, 25*time.Second); !ok || !strings.Contains(line, `"result"`) {
		t.Fatalf("warm-up reply: %q", line)
	}
	mcp, _ := f.status()["mcp"].(map[string]any)
	if mcp["state"] != "ok" || mcp["last_ok_at"] == nil || mcp["last_failure"] != nil {
		t.Fatalf("after an accepted call: %v", mcp)
	}
	if code, out := doctor(t, f); code != 0 {
		t.Fatalf("doctor failed with accepted MCP calls: exit %d %s", code, out)
	}

	c.send(`{"jsonrpc":"2.0","id":2,"method":"unauthorized"}`)
	line, ok := c.next(t, 25*time.Second)
	if !ok || !strings.Contains(line, "communicator_mcp_host_mismatch") || !strings.Contains(line, `"http_status":401`) {
		t.Fatalf("refused call reply: %q", line)
	}
	status := f.status()
	mcp, _ = status["mcp"].(map[string]any)
	failure, _ := mcp["last_failure"].(map[string]any)
	if status["connected"] != true {
		t.Fatalf("transport must stay connected: %v", status)
	}
	if mcp["state"] != "unauthorized" || mcp["last_status"] != float64(401) || failure["status"] != float64(401) || failure["code"] != "communicator_mcp_host_mismatch" || mcp["last_ok_at"] == nil {
		t.Fatalf("refusal not reported: %v", mcp)
	}
	raw, _ := json.Marshal(mcp)
	if strings.Contains(string(raw), "fixture") || strings.Contains(string(raw), "does not belong") {
		t.Fatalf("status leaked a credential or upstream text: %s", raw)
	}
	code, out := doctor(t, f)
	if code != 1 || !strings.Contains(out, `"state":"unauthorized"`) {
		t.Fatalf("doctor must fail on a refused MCP call: exit %d %s", code, out)
	}

	// The next accepted call clears the verdict but keeps the last failure.
	c.send(`{"jsonrpc":"2.0","id":3,"method":"ping"}`)
	if line, ok := c.next(t, 25*time.Second); !ok || !strings.Contains(line, `"result"`) {
		t.Fatalf("recovery reply: %q", line)
	}
	mcp, _ = f.status()["mcp"].(map[string]any)
	if mcp["state"] != "ok" || mcp["last_failure"] == nil {
		t.Fatalf("after recovery: %v", mcp)
	}
	if code, out := doctor(t, f); code != 0 {
		t.Fatalf("doctor after recovery: exit %d %s", code, out)
	}
}

func doctor(t *testing.T, f *mcpFixture) (int, string) {
	t.Helper()
	cmd := exec.Command(f.binary, "communicator", "doctor")
	cmd.Env = f.env
	out, err := cmd.Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), string(out)
	}
	if err != nil {
		t.Fatal(err)
	}
	return 0, string(out)
}

func TestMCPHealthStates(t *testing.T) {
	var h mcpHealth
	if h.state() != "unknown" || h.view()["last_failure"] != nil {
		t.Fatalf("fresh: %v", h.view())
	}
	now := time.Unix(1_800_000_000, 0)
	h.note(0, nil, now) // no upstream answer is not a result
	if h.state() != "unknown" {
		t.Fatalf("status 0 counted: %v", h.view())
	}
	h.note(403, []byte(`{"error":{"code":"agent_bridge_host_auth_changed"}}`), now)
	if h.state() != "unauthorized" || h.failure.code != "agent_bridge_host_auth_changed" {
		t.Fatalf("403: %v", h.view())
	}
	h.note(503, []byte(`{"code":"Not A Code; key=sk-secret"}`), now.Add(time.Second))
	if h.state() != "failing" || h.failure.code != "" {
		t.Fatalf("503 with unsafe code: %v", h.view())
	}
	h.note(202, nil, now.Add(2*time.Second))
	if h.state() != "ok" || h.view()["last_failure"] == nil {
		t.Fatalf("recovered: %v", h.view())
	}
}
