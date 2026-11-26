package accountpool

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type beatClient struct {
	responses []string
	requests  []string
	bodies    []map[string]any
	err       error
}

func (b *beatClient) JSON(_ context.Context, _ string, path string, in any, out any, _ int) error {
	b.requests = append(b.requests, path)
	if body, ok := in.(map[string]any); ok {
		b.bodies = append(b.bodies, body)
	}
	if b.err != nil {
		return b.err
	}
	if len(b.responses) == 0 || out == nil {
		return nil
	}
	raw := b.responses[0]
	b.responses = b.responses[1:]
	return json.Unmarshal([]byte(raw), out)
}

func boundContext(t *testing.T) *Context {
	t.Helper()
	c := Load("claude", filepath.Join(t.TempDir(), ".credentials.json"), "https://fleet")
	c.AccountID, c.SessionID, c.BindingGeneration, c.AccountLabel = 3, "abcdef0123", 2, "a@example.com"
	return c
}

func TestHeartbeatDirectiveFencing(t *testing.T) {
	c := boundContext(t)
	wake := c.SwitchWake()
	client := &beatClient{responses: []string{
		// Stale generation: ignored entirely.
		`{"account_id":3,"binding_generation":1,"account_switch":{"account_id":7,"binding_generation":1,"reason":"policy"}}`,
		// Current generation with a directive.
		`{"account_id":3,"binding_generation":2,"account_switch":{"account_id":7,"account_label":"b@example.com","binding_generation":2,"reason":"policy"}}`,
		// Older server: no generation, directive untouched.
		`{"account_id":3}`,
		// Explicit null clears.
		`{"account_id":3,"binding_generation":2,"account_switch":null}`,
		// A directive naming the bound account is nothing to do.
		`{"account_id":3,"binding_generation":2,"account_switch":{"account_id":3,"binding_generation":2}}`,
	}}
	if err := c.Heartbeat(context.Background(), client); err != nil || c.Pending() != nil {
		t.Fatalf("stale directive accepted: %+v %v", c.Pending(), err)
	}
	_ = c.Heartbeat(context.Background(), client)
	if d := c.Pending(); d == nil || d.AccountID != 7 || d.BindingGeneration != 2 || d.AccountLabel != "b@example.com" {
		t.Fatalf("directive: %+v", d)
	}
	select {
	case <-wake:
	default:
		t.Fatal("directive did not wake the supervisor")
	}
	_ = c.Heartbeat(context.Background(), client)
	if c.Pending() == nil {
		t.Fatal("absent field cleared the directive")
	}
	_ = c.Heartbeat(context.Background(), client)
	if c.Pending() != nil {
		t.Fatal("null did not clear the directive")
	}
	_ = c.Heartbeat(context.Background(), client)
	if c.Pending() != nil || c.AccountID != 3 {
		t.Fatal("self directive kept")
	}
}

func TestHeartbeatAdoptsSiblingSwitchOnlyWithNewerGeneration(t *testing.T) {
	c := boundContext(t)
	var adopted []Adoption
	c.OnAdopt(func(a Adoption) { adopted = append(adopted, a) })
	client := &beatClient{responses: []string{
		`{"account_id":7,"binding_generation":2}`,
		`{"account_id":7,"account_label":"b@example.com","binding_generation":3,"account_switch":null}`,
	}}
	_ = c.Heartbeat(context.Background(), client)
	if c.AccountID != 3 || len(adopted) != 0 {
		t.Fatal("adopted another account without a newer generation")
	}
	_ = c.Heartbeat(context.Background(), client)
	if c.AccountID != 7 || c.BindingGeneration != 3 || c.Label() != "b@example.com" || len(adopted) != 1 || adopted[0].PreviousAccountID != 3 {
		t.Fatalf("sibling switch not adopted: %+v %+v", c, adopted)
	}
	if Load("claude", filepath.Join(filepath.Dir(c.path), ".credentials.json"), "https://fleet").AccountID != 7 {
		t.Fatal("binding file not updated on adoption")
	}
	for _, path := range client.requests {
		if path != "/auth/sessions/heartbeat" {
			t.Fatalf("adoption performed %s (no credential traffic allowed)", path)
		}
	}
}

func TestObserveCarriesDirectiveButNeverAdopts(t *testing.T) {
	c := boundContext(t)
	c.Observe("/auth", []byte(`{"account_id":3,"verification_state":"verified","binding_generation":2,"account_switch":{"account_id":7,"binding_generation":2,"reason":"admin"}}`))
	if d := c.Pending(); d == nil || d.Reason != "admin" {
		t.Fatalf("directive from /auth: %+v", d)
	}
	c.Observe("/auth", []byte(`{"account_id":7,"verification_state":"verified","binding_generation":3,"account_switch":null}`))
	if c.AccountID != 3 || c.BindingGeneration != 2 || c.Pending() == nil {
		t.Fatal("/auth response switched or fenced the binding")
	}
	c.Observe("/sync/bootstrap", []byte(`{"auth":{"account_id":3,"verification_state":"verified","binding_generation":2,"account_switch":null}}`))
	if c.Pending() != nil {
		t.Fatal("bootstrap null did not clear the directive")
	}
}

type codedError string

func (e codedError) Error() string     { return string(e) }
func (e codedError) ErrorCode() string { return string(e) }

func TestCommitAndApplySwitch(t *testing.T) {
	c := boundContext(t)
	c.PendingSwitch = &SwitchDirective{AccountID: 7, BindingGeneration: 2, Reason: "agent"}
	client := &beatClient{responses: []string{`{"account_id":7,"account_label":"b@example.com","session_id":"abcdef0123","binding_generation":3,"previous_account_id":3,"auth":{"claudeAiOauth":{"accessToken":"b"}},"canonical_digest":"d","verification_state":"verified"}`}}
	res, err := c.CommitSwitch(context.Background(), client, *c.PendingSwitch)
	if err != nil {
		t.Fatal(err)
	}
	body := client.bodies[0]
	if client.requests[0] != "/auth/sessions/switch" || body["account_id"] != int64(7) || body["binding_generation"] != int64(2) || body["scope_id"] != c.ScopeID || body["session_id"] != "abcdef0123" {
		t.Fatalf("commit body: %v", body)
	}
	previous, label, err := c.ApplySwitch(res)
	if err != nil || previous != 3 || label != "a@example.com" || c.AccountID != 7 || c.BindingGeneration != 3 || c.Pending() != nil {
		t.Fatalf("apply: %d %q %v %+v", previous, label, err, c)
	}
	if _, err := c.CommitSwitch(context.Background(), &beatClient{err: codedError("account_switch_stale")}, SwitchDirective{AccountID: 9}); SwitchErrorCode(err) != "account_switch_stale" {
		t.Fatalf("stale code: %v", err)
	}
	if _, err := c.CommitSwitch(context.Background(), &beatClient{responses: []string{`{"account_id":9,"verification_state":"pending","auth":{}}`}}, SwitchDirective{AccountID: 9}); err == nil {
		t.Fatal("unverified switch accepted")
	}
	c.PendingSwitch = &SwitchDirective{AccountID: 9, BindingGeneration: 3}
	c.DropPending(SwitchDirective{AccountID: 9, BindingGeneration: 2})
	if c.Pending() == nil {
		t.Fatal("dropped a newer directive")
	}
	c.DropPending(SwitchDirective{AccountID: 9, BindingGeneration: 3})
	if c.Pending() != nil {
		t.Fatal("stale directive not dropped")
	}
}

func TestRequestSwitchValidatesTarget(t *testing.T) {
	client := &beatClient{responses: []string{`{"bound_account_id":3,"binding_generation":2,"account_switch":{"account_id":7,"binding_generation":2,"reason":"host"}}`}}
	for _, bad := range []any{int64(0), "best", 7} {
		if _, err := RequestSwitch(context.Background(), client, "claude", "abc", bad, "host"); err == nil {
			t.Fatalf("accepted target %v", bad)
		}
	}
	res, err := RequestSwitch(context.Background(), client, "claude", "abc", int64(7), "host")
	if err != nil || res.AccountSwitch == nil || res.AccountSwitch.AccountID != 7 {
		t.Fatalf("request: %+v %v", res, err)
	}
	if b := client.bodies[0]; b["account_id"] != int64(7) || b["reason"] != "host" || b["session_id"] != "abc" {
		t.Fatalf("request body: %v", b)
	}
}

func TestSessionMarkersFollowLeaseLifetime(t *testing.T) {
	c := boundContext(t)
	remove := c.writeSessionMarker("abcdef0123")
	if got := c.LiveSessions(); len(got) != 1 || got[0] != "abcdef0123" {
		t.Fatalf("live sessions: %v", got)
	}
	dead, _ := json.Marshal(sessionMarker{SessionID: "dead01", PID: 1 << 30})
	if err := os.WriteFile(filepath.Join(c.markerDir(), "dead01.json"), dead, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := c.LiveSessions(); len(got) != 1 {
		t.Fatalf("dead marker listed: %v", got)
	}
	if _, err := os.Stat(filepath.Join(c.markerDir(), "dead01.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("dead marker not pruned")
	}
	remove()
	if got := c.LiveSessions(); len(got) != 0 {
		t.Fatalf("marker survived release: %v", got)
	}
	c.writeSessionMarker("../escape")()
	if _, err := os.Stat(filepath.Join(filepath.Dir(c.markerDir()), "escape.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid session id escaped the marker directory")
	}
}
