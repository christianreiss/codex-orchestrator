package communicator_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	comm "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	claude "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	codex "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"golang.org/x/net/websocket"
)

type retryCaller interface {
	JSON(context.Context, string, string, any, any, int) error
	Do(context.Context, *http.Request, int) (*http.Response, error)
}

func newRetryCaller(t *testing.T, engine, base string) retryCaller {
	t.Helper()
	// Keep response observation in memory; never consult native account files.
	pool := &accountpool.Context{Engine: engine}
	if engine == "codex" {
		c, err := codex.New(codex.Options{BaseURL: base, APIKey: "test-host", Timeout: 3 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		c.Pool = pool
		return c
	}
	c, err := claude.New(claude.Options{BaseURL: base, APIKey: "test-host", Timeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	c.Pool = pool
	return c
}

func callWithRetries(t *testing.T, c retryCaller, entry, base, path, body string) (int, string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if entry == "JSON" {
		err := c.JSON(ctx, http.MethodPost, path, json.RawMessage(body), nil, 2)
		var ce *codex.HTTPError
		var ae *claude.HTTPError
		if errors.As(err, &ce) {
			return ce.StatusCode, ce.Code, err
		}
		if errors.As(err, &ae) {
			return ae.StatusCode, ae.Code, err
		}
		return 0, "", err
	}
	req, err := http.NewRequest(http.MethodPost, base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.Do(ctx, req, 2)
	if err != nil {
		return 0, "", err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	var envelope struct {
		Code  string `json:"code"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err == nil {
		err = json.Unmarshal(raw, &envelope)
	}
	if envelope.Code == "" {
		envelope.Code = envelope.Error.Code
	}
	return res.StatusCode, envelope.Code, err
}

// The fake API applies an effect before producing a wire-level failure. These
// are caller/owner regressions, not a substitute for the API dispatcher's tests.
func TestCallerRetryUnsafeOutcomes(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		for _, entry := range []string{"JSON", "Do"} {
			for _, failure := range []string{"legacy_oversized_502", "oversized_409", "lost_control_reply", "lost_local_reply"} {
				for _, op := range []struct{ name, path, body string }{
					{"auth_store", "/auth", `{"command":"store"}`},
					{"bootstrap_auth", "/sync/bootstrap", `{"include_auth":true}`},
					{"bootstrap_implicit_auth", "/sync/bootstrap", `{}`},
					{"bootstrap_candidate", "/sync/bootstrap", `{"include_auth":false,"auth_candidate":{"tokens":{}}}`},
					{"bootstrap_session", "/sync/bootstrap/", `{"include_auth":false,"session_id":"native-session"}`},
					{"mcp_mutation", "/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"agent_send","arguments":{"to":"agent:test","content":"test"}}}`},
				} {
					t.Run(engine+"/"+entry+"/"+failure+"/"+op.name, func(t *testing.T) {
						var effects, transfers atomic.Int32
						base, attempts, _ := comm.NewCallerRetryOwner(t, func(ws *websocket.Conn, f comm.CallerRetryFrame) {
							if f.Method != http.MethodPost || f.Path != op.path || string(f.Body) != op.body {
								t.Errorf("unexpected operation: %s %s %s", f.Method, f.Path, f.Body)
							}
							effects.Add(1)
							reply := comm.CallerRetryFrame{ID: f.ID, Status: 200, Body: []byte(`{"ok":true}`)}
							switch failure {
							case "legacy_oversized_502":
								reply.Status, reply.Body = 502, []byte(`{"code":"communicator_response_too_large"}`)
							case "oversized_409":
								reply.Status, reply.Body = 409, []byte(`{"code":"communicator_outcome_unknown"}`)
							case "lost_control_reply":
								ws.Close()
								return
							}
							_ = websocket.JSON.Send(ws, reply)
						}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
							transfers.Add(1)
							effects.Add(1)
							io.WriteString(w, `{"ok":true}`)
						}), failure == "lost_local_reply")
						status, code, err := callWithRetries(t, newRetryCaller(t, engine, base), entry, base, op.path, op.body)
						if status != 409 || code != "communicator_outcome_unknown" || (entry == "JSON") != (err != nil) {
							t.Fatalf("unknown outcome lost: status=%d code=%s err=%v", status, code, err)
						}
						if effects.Load() != 1 || attempts.Load() != 1 || transfers.Load() != 0 {
							t.Fatalf("automatic replay: effects=%d local=%d transfer=%d", effects.Load(), attempts.Load(), transfers.Load())
						}
						t.Logf("HTTP=%d code=%s effects=%d local=%d transfer=%d retries=2", status, code, effects.Load(), attempts.Load(), transfers.Load())
					})
				}
			}
		}
	}
}

func TestCallerRetrySafeBootstrapFallsBackOnce(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		for _, entry := range []string{"JSON", "Do"} {
			t.Run(engine+"/"+entry, func(t *testing.T) {
				var frames, transfers atomic.Int32
				base, attempts, _ := comm.NewCallerRetryOwner(t, func(ws *websocket.Conn, f comm.CallerRetryFrame) {
					frames.Add(1)
					_ = websocket.JSON.Send(ws, comm.CallerRetryFrame{ID: f.ID, Status: 502, Body: []byte(`{"code":"communicator_response_too_large"}`)})
				}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					transfers.Add(1)
					raw, _ := io.ReadAll(r.Body)
					if r.Method != "POST" || r.URL.Path != "/sync/bootstrap/" || string(raw) != `{"include_auth":false}` || r.Header.Get("X-API-Key") != "test-host" {
						t.Errorf("fallback changed request: %s %s %s", r.Method, r.URL.Path, raw)
					}
					io.WriteString(w, `{"ok":true}`)
				}), false)
				status, _, err := callWithRetries(t, newRetryCaller(t, engine, base), entry, base, "/sync/bootstrap/", `{"include_auth":false}`)
				if err != nil || (entry == "Do" && status != 200) || frames.Load() != 1 || attempts.Load() != 1 || transfers.Load() != 1 {
					t.Fatalf("fallback: status=%d err=%v frames=%d local=%d transfer=%d", status, err, frames.Load(), attempts.Load(), transfers.Load())
				}
				t.Logf("control=%d local=%d transfer=%d retries=2", frames.Load(), attempts.Load(), transfers.Load())
			})
		}
	}
}

func TestCallerRetryExplicitIdempotencyKey(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		t.Run(engine, func(t *testing.T) {
			var calls, effects atomic.Int32
			const key = "ab55f397-09b8-4c4a-8b5e-319f9c66f01e"
			const body = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"agent_send","arguments":{"client_message_id":"` + key + `"}}}`
			// Fake durable API ledger. The second dispatch deduplicates by the
			// explicit key; the communicator does not manufacture exactly-once semantics.
			seen := make(map[string]bool)
			var ledgerMu sync.Mutex
			base, attempts, reconnect := comm.NewCallerRetryOwner(t, func(ws *websocket.Conn, f comm.CallerRetryFrame) {
				ledgerMu.Lock()
				defer ledgerMu.Unlock()
				var request struct {
					Params struct {
						Arguments struct {
							Key string `json:"client_message_id"`
						} `json:"arguments"`
					} `json:"params"`
				}
				if json.Unmarshal(f.Body, &request) != nil || request.Params.Arguments.Key != key {
					t.Error("idempotency key lost")
				}
				calls.Add(1)
				if !seen[request.Params.Arguments.Key] {
					seen[request.Params.Arguments.Key] = true
					effects.Add(1)
					ws.Close()
					return
				}
				_ = websocket.JSON.Send(ws, comm.CallerRetryFrame{ID: f.ID, Status: 200, Body: []byte(`{"created":false}`)})
			}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected direct transfer") }), false)
			client := newRetryCaller(t, engine, base)
			status, code, _ := callWithRetries(t, client, "JSON", base, "/mcp", body)
			if status != 409 || code != "communicator_outcome_unknown" || attempts.Load() != 1 || effects.Load() != 1 {
				t.Fatalf("first call: status=%d code=%s local=%d effects=%d", status, code, attempts.Load(), effects.Load())
			}
			reconnect()
			var result struct {
				Created *bool `json:"created"`
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err := client.JSON(ctx, "POST", "/mcp", json.RawMessage(body), &result, 2)
			if err != nil || result.Created == nil || *result.Created || calls.Load() != 2 || attempts.Load() != 2 || effects.Load() != 1 {
				t.Fatalf("explicit retry: result=%+v err=%v calls=%d local=%d effects=%d", result, err, calls.Load(), attempts.Load(), effects.Load())
			}
			t.Logf("explicit retry: created=false calls=%d local=%d effects=%d", calls.Load(), attempts.Load(), effects.Load())
		})
	}
}

// Positive control: the retry budget really is enabled in both clients and
// entrypoints. A generic retryable failure must reach the API a second time.
func TestCallerRetryBudgetIsActive(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		for _, entry := range []string{"JSON", "Do"} {
			t.Run(engine+"/"+entry, func(t *testing.T) {
				var frames atomic.Int32
				base, attempts, _ := comm.NewCallerRetryOwner(t, func(ws *websocket.Conn, f comm.CallerRetryFrame) {
					status := 200
					if frames.Add(1) == 1 {
						status = 503
					}
					_ = websocket.JSON.Send(ws, comm.CallerRetryFrame{ID: f.ID, Status: status, Body: []byte(`{"ok":true}`)})
				}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected direct transfer") }), false)
				status, _, err := callWithRetries(t, newRetryCaller(t, engine, base), entry, base, "/sync/bootstrap", `{"include_auth":false}`)
				if err != nil || (entry == "Do" && status != 200) || frames.Load() != 2 || attempts.Load() != 2 {
					t.Fatalf("retry not exercised: status=%d err=%v frames=%d local=%d", status, err, frames.Load(), attempts.Load())
				}
				t.Logf("retryable 503: frames=%d local=%d", frames.Load(), attempts.Load())
			})
		}
	}
}
