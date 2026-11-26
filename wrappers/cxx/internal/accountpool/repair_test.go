package accountpool

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type reserveClient struct {
	lease    string
	requests []string
	bodies   []map[string]any
}

func (r *reserveClient) JSON(_ context.Context, _ string, path string, in any, out any, _ int) error {
	r.requests = append(r.requests, path)
	body, _ := in.(map[string]any)
	r.bodies = append(r.bodies, body)
	switch path {
	case "/auth/sessions/heartbeat":
		return statusError(404)
	case "/auth/sessions":
		return json.Unmarshal([]byte(r.lease), out)
	}
	return nil
}

// A scope whose leases were all gone gets its generation from the server
// again. An older server counted from 1; the number remembered here must not
// outlive the lease it belonged to, or every later directive is ignored.
func TestReReservedLeaseTakesTheServersGeneration(t *testing.T) {
	c := boundContext(t)
	c.BindingGeneration = 9
	c.PendingSwitch = &SwitchDirective{AccountID: 7, BindingGeneration: 9}
	client := &reserveClient{lease: `{"account_id":3,"session_id":"abcdef0123","verification_state":"verified","binding_generation":1}`}
	if err := c.Heartbeat(context.Background(), client); err != nil {
		t.Fatal(err)
	}
	if c.BindingGeneration != 1 || c.Pending() != nil {
		t.Fatalf("generation %d, pending %+v", c.BindingGeneration, c.Pending())
	}
	if _, sent := client.bodies[1]["ownership_mode"]; sent {
		t.Fatalf("a host without the state channel asked for a connection-owned lease: %v", client.bodies[1])
	}
	// From here the fence works as for any other answer.
	beats := &beatClient{responses: []string{
		`{"account_id":3,"binding_generation":1,"account_switch":{"account_id":7,"binding_generation":1,"reason":"policy"}}`,
	}}
	if err := c.Heartbeat(context.Background(), beats); err != nil {
		t.Fatal(err)
	}
	if d := c.Pending(); d == nil || d.AccountID != 7 || d.BindingGeneration != 1 {
		t.Fatalf("directive after the restart was ignored: %+v", d)
	}
}

func TestReReservedLeaseKeepsAHigherGenerationAndItsDirective(t *testing.T) {
	c := boundContext(t)
	client := &reserveClient{lease: `{"account_id":3,"session_id":"abcdef0123","verification_state":"verified","binding_generation":1795720000,"account_switch":{"account_id":7,"binding_generation":1795720000,"reason":"admin"}}`}
	if err := c.Heartbeat(context.Background(), client); err != nil {
		t.Fatal(err)
	}
	if d := c.Pending(); c.BindingGeneration != 1795720000 || d == nil || d.AccountID != 7 {
		t.Fatalf("generation %d, pending %+v", c.BindingGeneration, d)
	}
}

func TestDirectiveSaysWhenTheBoundAccountCannotConfirmAFlush(t *testing.T) {
	for raw, want := range map[string]bool{
		`{"account_id":7,"binding_generation":2}`:                              false,
		`{"account_id":7,"binding_generation":2,"bound_account_usable":true}`:  false,
		`{"account_id":7,"binding_generation":2,"bound_account_usable":false}`: true,
	} {
		var d SwitchDirective
		if err := json.Unmarshal([]byte(raw), &d); err != nil {
			t.Fatal(err)
		}
		if d.LeavesUnusableAccount() != want {
			t.Fatalf("%s: relaxed=%v", raw, d.LeavesUnusableAccount())
		}
	}
}

func TestUnfinishedSwitchRepeatsTheCommitWithItsFence(t *testing.T) {
	c := boundContext(t)
	client := &beatClient{responses: []string{`{"account_id":7,"verification_state":"verified","auth":{"claudeAiOauth":{}},"binding_generation":3}`}}
	d := SwitchDirective{AccountID: 7, BindingGeneration: 2}
	if err := c.ReportUnfinishedSwitch(context.Background(), client, d); err != nil {
		t.Fatal(err)
	}
	body := client.bodies[0]
	if client.requests[0] != "/auth/sessions/switch" || body["credential_write"] != "unfinished" || body["binding_generation"] != int64(2) || body["account_id"] != int64(7) {
		t.Fatalf("report: %v %v", client.requests, body)
	}
	client.responses = []string{`{"account_id":7,"verification_state":"verified","auth":{"claudeAiOauth":{}}}`}
	if _, err := c.CommitSwitch(context.Background(), client, d); err != nil {
		t.Fatal(err)
	}
	if _, sent := client.bodies[1]["credential_write"]; sent {
		t.Fatalf("an ordinary commit reported an unfinished write: %v", client.bodies[1])
	}
}

func TestRepairFlagBelongsToTheScopeAndSurvivesTheProcess(t *testing.T) {
	auth := filepath.Join(t.TempDir(), ".credentials.json")
	c := Load("claude", auth, "https://fleet")
	if c.RepairPending() {
		t.Fatal("a new scope needs no repair")
	}
	c.MarkRepair()
	c.MarkRepair()
	// A wrapper started later, or the communicator, reads the same flag.
	other := Load("claude", auth, "https://fleet")
	if !other.RepairPending() {
		t.Fatal("flag not visible to another process of the scope")
	}
	if Load("claude", auth, "https://other-fleet").RepairPending() {
		t.Fatal("flag leaked to another server's binding")
	}
	other.ClearRepair()
	if c.RepairPending() {
		t.Fatal("flag survived the repair")
	}
	var none *Context
	none.MarkRepair()
	none.ClearRepair()
	if none.RepairPending() {
		t.Fatal("nil context")
	}
}

func TestSessionMarkersPublishTheTurnOfEachLaunch(t *testing.T) {
	auth := filepath.Join(t.TempDir(), ".credentials.json")
	own := Load("claude", auth, "https://fleet")
	own.SessionID = "aaaa000000000001"
	sibling := Load("claude", auth, "https://fleet")
	sibling.SessionID = "bbbb000000000002"
	defer own.writeSessionMarker(own.SessionID)()
	removeSibling := sibling.writeSessionMarker(sibling.SessionID)

	turns := func() [2]bool {
		busy, unknown := own.SiblingTurns()
		return [2]bool{busy, unknown}
	}
	// A sibling that publishes nothing is unknown, never idle.
	if got := turns(); got != [2]bool{false, true} {
		t.Fatalf("silent sibling: %v", got)
	}
	sibling.SetSessionTurn(false, true)
	if got := turns(); got != [2]bool{true, false} {
		t.Fatalf("busy sibling: %v", got)
	}
	// The own marker never counts: the caller holds better evidence for it.
	own.SetSessionTurn(false, true)
	if busy, _ := sibling.SiblingTurns(); !busy {
		t.Fatal("own busy turn invisible to the sibling")
	}
	sibling.SetSessionTurn(true, true)
	if got := turns(); got != [2]bool{false, false} {
		t.Fatalf("idle sibling: %v", got)
	}
	// A busy turn no hook confirmed for a long time (interrupted: no Stop
	// ever came) is no evidence any more.
	sibling.SetSessionTurn(false, true)
	path := filepath.Join(sibling.markerDir(), sibling.SessionID+".json")
	var stale sessionMarker
	raw, _ := os.ReadFile(path)
	if err := json.Unmarshal(raw, &stale); err != nil || stale.Turn != turnBusy || stale.TurnAt.IsZero() {
		t.Fatalf("busy marker: %s %v", raw, err)
	}
	stale.TurnAt = stale.TurnAt.Add(-busyTurnFresh - time.Minute)
	raw, _ = json.Marshal(stale)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := turns(); got != [2]bool{false, true} {
		t.Fatalf("stale busy sibling: %v", got)
	}
	// The next hook of a turn that is in fact running confirms it again.
	sibling.SetSessionTurn(false, true)
	if got := turns(); got != [2]bool{true, false} {
		t.Fatalf("confirmed busy sibling: %v", got)
	}
	// Evidence lost (the native session changed): back to unknown.
	sibling.SetSessionTurn(false, false)
	if got := turns(); got != [2]bool{false, true} {
		t.Fatalf("sibling without evidence: %v", got)
	}
	if ids := own.LiveSessions(); len(ids) != 2 {
		t.Fatalf("turn updates broke the markers: %v", ids)
	}
	removeSibling()
	if got := turns(); got != [2]bool{false, false} {
		t.Fatalf("no sibling: %v", got)
	}
	// A released launch does not bring its marker back.
	sibling.SetSessionTurn(false, true)
	if _, err := os.Stat(filepath.Join(sibling.markerDir(), sibling.SessionID+".json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("turn update recreated a released marker")
	}
}
