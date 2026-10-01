package accountpool

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type fakeClient struct {
	requests []string
	bodies   []map[string]any
	account  int64
}

func (f *fakeClient) JSON(_ context.Context, _ string, path string, in any, out any, _ int) error {
	f.requests = append(f.requests, path)
	body := in.(map[string]any)
	f.bodies = append(f.bodies, body)
	if path == "/auth/sessions" {
		id := f.account
		if id == 0 {
			id = 7
		}
		*out.(*LeaseResponse) = LeaseResponse{AccountID: id, SessionID: body["session_id"].(string), VerificationState: "verified", Auth: json.RawMessage(`{"tokens":{"access_token":"test"}}`), CanonicalDigest: "digest", AccountLabel: "Claude seven"}
	}
	return nil
}
func TestBindingScopesAndObservesOnlyVerifiedMetadata(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.json")
	c := Load("codex", path, "https://fleet")
	c.Observe("/auth", []byte(`{"account_pool":true,"account_id":3,"verification_state":"failed"}`))
	if c.AccountID != 0 || !c.Capable {
		t.Fatal("accepted failed credentials or missed pool support")
	}
	c.Observe("/sync/bootstrap", []byte(`{"auth":{"account_pool":true,"account_id":3,"verification_state":"verified"}}`))
	again := Load("codex", path, "https://fleet")
	if again.AccountID != 3 || again.ScopeID != c.ScopeID {
		t.Fatal("binding not persistent")
	}
	info, err := os.Stat(c.path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("binding permissions: %v %v", info, err)
	}
	if Load("codex", path, "https://different-fleet").AccountID != 0 {
		t.Fatal("binding leaked across servers")
	}
	original := map[string]any{"command": "retrieve"}
	tagged := c.Inject("/auth", original).(map[string]any)
	if tagged["account_id"] != int64(3) || original["account_id"] != nil {
		t.Fatal("request binding modified caller")
	}
	c.SessionID = "active"
	c.Observe("/auth", []byte(`{"account_id":4,"verification_state":"verified"}`))
	if c.AccountID != 3 {
		t.Fatal("response switched a running session")
	}
}
func TestLeaseSelectionReleaseAndNativeCompareAndSwap(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		active    bool
		selected  int64
		cas       bool
		wantError bool
	}{
		{"idle switch", false, 7, true, false}, {"same active account", true, 3, true, false},
		{"active switch refused", true, 7, true, true}, {"native changed", false, 7, false, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			c := Load("claude", filepath.Join(t.TempDir(), ".credentials.json"), "https://fleet")
			c.AccountID = 3
			c.Capable = true
			f := &fakeClient{account: scenario.selected}
			stop, lease, err := c.Start(context.Background(), f, scenario.active, func(_ json.RawMessage, _ string, switching bool) (bool, error) {
				if switching != (scenario.selected != 3) {
					t.Fatal("incorrect switch guard")
				}
				return scenario.cas, nil
			})
			if (err != nil) != scenario.wantError {
				t.Fatalf("Start: %v", err)
			}
			if err == nil {
				if lease.AccountID != scenario.selected {
					t.Fatal("wrong account")
				}
				stop()
				stop()
			}
			if len(f.requests) != 2 || f.requests[1] != "/auth/sessions/release" {
				t.Fatalf("lease not released once: %v", f.requests)
			}
			if scenario.active && f.bodies[0]["account_id"] != int64(3) {
				t.Fatal("active child not pinned")
			}
			if !scenario.active && f.bodies[0]["account_id"] != nil {
				t.Fatal("idle launch pinned previous account")
			}
		})
	}
}
func TestLegacyServersAndFailedNativeWrites(t *testing.T) {
	c := Load("codex", filepath.Join(t.TempDir(), "auth.json"), "https://fleet")
	f := &fakeClient{}
	stop, lease, err := c.Start(context.Background(), f, false, func(json.RawMessage, string, bool) (bool, error) { t.Fatal("legacy wrote auth"); return true, nil })
	if err != nil || lease != nil || len(f.requests) != 0 {
		t.Fatal("legacy requested leases")
	}
	stop()
	c.Capable = true
	_, _, err = c.Start(context.Background(), f, false, func(json.RawMessage, string, bool) (bool, error) { return false, errors.New("write failed") })
	if err == nil || c.AccountID != 0 || c.SessionID != "" {
		t.Fatal("failed write changed binding")
	}
}
func TestInheritedUsageBinding(t *testing.T) {
	t.Setenv("CXX_PROVIDER_ACCOUNT_ID", "9")
	t.Setenv("CXX_PROVIDER_SESSION_ID", "native-session")
	b := map[string]any{}
	AddEnvironmentBinding(b)
	if b["account_id"] != int64(9) || b["session_id"] != "native-session" {
		t.Fatalf("usage binding: %v", b)
	}
}
