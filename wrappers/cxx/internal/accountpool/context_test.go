package accountpool

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

type fakeClient struct {
	requests []string
	bodies   []map[string]any
	account  int64
}

type blockedReleaseClient struct {
	fakeClient
	started chan struct{}
	ack     chan struct{}
}

func (f *blockedReleaseClient) JSON(ctx context.Context, method, path string, in, out any, retries int) error {
	if path == "/auth/sessions/release" {
		close(f.started)
		select {
		case <-f.ack:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return f.fakeClient.JSON(ctx, method, path, in, out, retries)
}

func TestLeaseReleaseUsesDurableHandoffAndSynchronousFallback(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok", "kimi"} {
		for _, mode := range []string{"durable", "journal_unwritable", "unmanaged"} {
			t.Run(engine+"/"+mode, func(t *testing.T) {
				home := t.TempDir()
				t.Setenv("HOME", home)
				runtime, err := os.MkdirTemp("", "lease-exit-")
				if err != nil {
					t.Fatal(err)
				}
				defer os.RemoveAll(runtime)
				t.Setenv("XDG_RUNTIME_DIR", runtime)
				t.Setenv("CXX_COMMUNICATOR_SYNC", "")
				base := "https://lease-" + strconv.FormatInt(time.Now().UnixNano(), 10) + ".fixture.invalid"
				wake := make(chan struct{}, 1)
				if mode != "unmanaged" {
					cfg := config.Config{SchemaVersion: 1, Engine: engine, IssuedAt: "2026-11-04T00:00:00Z", Orchestrator: config.Orchestrator{BaseURL: base, APIKey: "fixture-host-key", InstallationID: "fixture", CommunicatorProtocol: 1}, Host: config.Host{ID: 1, FQDN: "fixture.invalid", Secure: true}, Wrapper: config.Wrapper{Version: "0.9.159", Track: "stable", BinaryURL: base + "/download", BinarySHA256: strings.Repeat("0", 64)}}
					path := filepath.Join(home, "config.json")
					raw, _ := json.Marshal(cfg)
					if err := os.WriteFile(path, raw, 0600); err != nil {
						t.Fatal(err)
					}
					loaded, err := config.LoadForEngine(path, nil, true, engine)
					if err != nil {
						t.Fatal(err)
					}
					communicator.WithSyncConfig(context.Background(), loaded)
					dirs, _ := filepath.Glob(filepath.Join(runtime, "cxx-comm-*"))
					if len(dirs) != 1 {
						t.Fatalf("private owner directories: %v", dirs)
					}
					listener, err := net.Listen("unix", filepath.Join(dirs[0], "control.sock"))
					if err != nil {
						t.Fatal(err)
					}
					owner := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.URL.Path == "/_comm/provider-release" {
							wake <- struct{}{}
							w.WriteHeader(http.StatusAccepted)
							return // Local wake acknowledgement does not wait for remote release.
						}
						_, _ = w.Write([]byte(`{"protocol":1,"control_state_protocol":0}`))
					})}
					go owner.Serve(listener)
					defer owner.Close()
					if mode == "journal_unwritable" {
						if err := os.WriteFile(filepath.Join(home, ".cxx"), []byte("not a directory"), 0600); err != nil {
							t.Fatal(err)
						}
					}
				}
				pool := Load(engine, filepath.Join(home, "auth.json"), base)
				pool.Capable = true
				client := &blockedReleaseClient{started: make(chan struct{}), ack: make(chan struct{})}
				stop, lease, err := pool.Start(context.Background(), client, false, func(json.RawMessage, string, bool) (bool, error) { return true, nil })
				if err != nil {
					t.Fatal(err)
				}
				done := make(chan struct{})
				go func() { stop(); stop(); close(done) }()
				if mode == "durable" {
					select {
					case <-done:
					case <-client.started:
						close(client.ack)
						<-done
						t.Fatal("durably queued release still waited on duplicate remote POST")
					case <-time.After(2 * time.Second):
						t.Fatal("durable handoff blocked shell return")
					}
					select {
					case <-wake:
					default:
						t.Fatal("durable release did not wake owner")
					}
					files, _ := filepath.Glob(filepath.Join(home, ".cxx", "receipts", "*", "provider-release", lease.SessionID+".json"))
					if len(files) != 1 {
						t.Fatalf("pending release receipt lost: %v", files)
					}
					raw, err := os.ReadFile(files[0])
					var receipt map[string]string
					if err != nil || json.Unmarshal(raw, &receipt) != nil || receipt["engine"] != engine || receipt["session_id"] != lease.SessionID {
						t.Fatalf("wrong durable receipt: %s %v", raw, err)
					}
					communicator.AcknowledgeProviderRelease(base, lease.SessionID)
					if _, err := os.Stat(files[0]); !os.IsNotExist(err) {
						t.Fatal("acknowledged receipt retained")
					}
				} else {
					select {
					case <-client.started:
					case <-time.After(time.Second):
						t.Fatal("missing synchronous fallback")
					}
					select {
					case <-done:
						t.Fatal("fallback returned before release acknowledged")
					default:
					}
					close(client.ack)
					select {
					case <-done:
					case <-time.After(time.Second):
						t.Fatal("fallback ignored release acknowledgement")
					}
				}
			})
		}
	}
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

type statusError int

func (e statusError) Error() string   { return "status" }
func (e statusError) HTTPStatus() int { return int(e) }

type heartbeatClient struct {
	heartbeat error
	account   int64
	requests  []string
	bodies    []map[string]any
}

func (f *heartbeatClient) JSON(_ context.Context, _ string, path string, in any, out any, _ int) error {
	body := in.(map[string]any)
	f.requests = append(f.requests, path)
	f.bodies = append(f.bodies, body)
	switch path {
	case "/auth/sessions/heartbeat":
		return f.heartbeat
	case "/auth/sessions":
		*out.(*LeaseResponse) = LeaseResponse{AccountID: f.account, SessionID: body["session_id"].(string), VerificationState: "verified"}
	}
	return nil
}

func TestHeartbeatReacquiresReapedLease(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		heartbeat error
		account   int64
		want      []string
	}{
		{"live lease", nil, 3, []string{"/auth/sessions/heartbeat"}},
		{"transient failure", errors.New("offline"), 3, []string{"/auth/sessions/heartbeat"}},
		{"removed account", statusError(409), 3, []string{"/auth/sessions/heartbeat"}},
		{"reaped after sleep", statusError(404), 3, []string{"/auth/sessions/heartbeat", "/auth/sessions"}},
		{"reattached elsewhere", statusError(404), 7, []string{"/auth/sessions/heartbeat", "/auth/sessions", "/auth/sessions/release"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			c := Load("claude", filepath.Join(t.TempDir(), ".credentials.json"), "https://fleet")
			f := &heartbeatClient{heartbeat: scenario.heartbeat, account: scenario.account}
			c.heartbeat(context.Background(), f, "session-0123456789", 3)
			if len(f.requests) != len(scenario.want) {
				t.Fatalf("requests: %v", f.requests)
			}
			for i := range scenario.want {
				if f.requests[i] != scenario.want[i] {
					t.Fatalf("requests: %v", f.requests)
				}
			}
			if len(f.requests) > 1 {
				b := f.bodies[1]
				if b["session_id"] != "session-0123456789" || b["account_id"] != int64(3) || b["scope_id"] != c.ScopeID {
					t.Fatalf("re-acquire body: %v", b)
				}
			}
		})
	}
}

type gatewayClient struct {
	fakeClient
	failure  error
	attempts int
	firstID  string
}

func (f *gatewayClient) JSON(ctx context.Context, method, path string, in any, out any, retries int) error {
	if path == "/auth/sessions" {
		f.attempts++
		id := in.(map[string]any)["session_id"].(string)
		if f.firstID == "" {
			f.firstID = id
		}
		if id != f.firstID {
			return errors.New("retry changed lease identity")
		}
		if f.attempts == 1 {
			return f.failure
		}
	}
	return f.fakeClient.JSON(ctx, method, path, in, out, retries)
}
func TestLaunchRetriesGatewayFailureWithSameLeaseAndActiveAccount(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok", "kimi"} {
		t.Run(engine, func(t *testing.T) {
			c := Load(engine, filepath.Join(t.TempDir(), "auth.json"), "https://fleet")
			c.Capable, c.AccountID = true, 3
			f := &gatewayClient{fakeClient: fakeClient{account: 3}, failure: statusError(502)}
			stop, _, err := c.Start(context.Background(), f, true, func(json.RawMessage, string, bool) (bool, error) { return true, nil })
			if err != nil {
				t.Fatal(err)
			}
			stop()
			if f.attempts != 2 || f.bodies[0]["account_id"] != int64(3) {
				t.Fatalf("attempts=%d bodies=%v", f.attempts, f.bodies)
			}
		})
	}
}
func TestLeaseRetryDoesNotRetryPermanentFailureAndHonorsCancellation(t *testing.T) {
	for _, code := range []int{401, 403, 409, 429, 502, 503, 504} {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			f := &gatewayClient{failure: statusError(code)}
			err := acquireLease(ctx, f, map[string]any{"session_id": "same"}, &LeaseResponse{})
			if f.attempts != 1 || err == nil {
				t.Fatalf("attempts=%d err=%v", f.attempts, err)
			}
			if code >= 502 && !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
		})
	}
}
