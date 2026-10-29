package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClaimStatusRetriesOnlyTransientSafeReads(t *testing.T) {
	for _, tc := range []struct {
		suffix, code string
		status       int
		response     bool
		want         int
	}{
		{"claims/status", "communicator_unavailable", 502, false, 3},
		{"claims/status", "communicator_unavailable", 503, false, 3},
		{"claims/status", "api_disabled", 503, false, 1},
		{"claims/status", "forbidden", 403, false, 1},
		{"claims/status", "communicator_unavailable", 502, true, 1},
		{"claims/acquire", "communicator_unavailable", 502, false, 1},
		{"claims/acquire", "native_attachment_unavailable", 502, false, 1},
		{"claims/acquire", "communicator_outcome_unknown", 409, false, 1},
		{"claims/acquire", "forbidden", 403, false, 1},
		{"claims/release", "broker_upstream_unavailable", 502, false, 1},
		{"rooms/send", "native_attachment_unavailable", 503, false, 1},
	} {
		t.Run(tc.suffix+tc.code, func(t *testing.T) {
			calls := 0
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				calls++
				if calls == 3 {
					return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"state":"active"}`)), Header: http.Header{}}, nil
				}
				return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(`{"code":"` + tc.code + `","message":"temporary"}`)), Header: http.Header{}}, nil
			})}}
			args := map[string]any{"claim_id": "claim", "renew": true}
			if tc.response {
				args["response"] = "wait"
			}
			var out map[string]any
			err := client.post(context.Background(), tc.suffix, args, &out)
			if calls != tc.want {
				t.Fatalf("calls=%d, want=%d", calls, tc.want)
			}
			if tc.want == 3 && (err != nil || out["state"] != "active") {
				t.Fatalf("renewal recovery: %v %v", out, err)
			}
		})
	}
}

// The broker rejects claims before dispatch while its exact native attachment
// reconnects. The same explicit operation should survive that temporary gap.
func TestClaimAttachmentReconnectPreservesOperation(t *testing.T) {
	for _, suffix := range []string{"claims/acquire", "claims/status", "claims/release"} {
		t.Run(suffix, func(t *testing.T) {
			calls := 0
			body := map[string]any{"client_request_id": "stable-request", "claim_id": "same-claim", "response": "wait"}
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var got map[string]any
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Error(err)
				}
				if got["client_request_id"] != body["client_request_id"] || got["claim_id"] != body["claim_id"] || got["response"] != body["response"] {
					t.Errorf("operation changed: %v", got)
				}
				if calls == 1 {
					w.WriteHeader(503)
					io.WriteString(w, `{"code":"native_attachment_unavailable","message":"Native process attachment is reconnecting"}`)
					return
				}
				io.WriteString(w, `{"state":"active"}`)
			}))
			defer remote.Close()
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				r.URL.Scheme = "http"
				r.URL.Host = strings.TrimPrefix(remote.URL, "http://")
				return http.DefaultTransport.RoundTrip(r)
			})}}
			var out map[string]any
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := client.post(ctx, suffix, body, &out); err != nil || out["state"] != "active" || calls != 2 {
				t.Fatalf("reconnect abandoned operation: calls=%d out=%v err=%v", calls, out, err)
			}
		})
	}
}

func TestClaimAttachmentReconnectHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		cancel()
		return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader(`{"code":"native_attachment_unavailable"}`)), Header: http.Header{}}, nil
	})}}
	err := client.post(ctx, "claims/acquire", map[string]any{"client_request_id": "same"}, nil)
	if !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatalf("cancellation ignored: calls=%d err=%v", calls, err)
	}
}

func TestClaimAttachmentReconnectNeverReplaysDispatchedFailure(t *testing.T) {
	calls := 0
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		status, body := 503, `{"code":"native_attachment_unavailable"}`
		if calls > 1 {
			status, body = 409, `{"code":"communicator_outcome_unknown"}`
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
	})}}
	err := client.post(context.Background(), "claims/acquire", map[string]any{"client_request_id": "same"}, nil)
	var api *APIError
	if calls != 2 || !errors.As(err, &api) || api.Code != "communicator_outcome_unknown" {
		t.Fatalf("unknown outcome replayed or hidden: calls=%d err=%v", calls, err)
	}
}

func TestClaimAttachmentReconnectDeadline(t *testing.T) {
	calls := 0
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader(`{"code":"native_attachment_unavailable"}`)), Header: http.Header{}}, nil
	})}}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	err := client.post(ctx, "claims/acquire", nil, nil)
	if !errors.Is(err, context.DeadlineExceeded) || calls != 1 || time.Since(started) > time.Second {
		t.Fatalf("deadline ignored: calls=%d err=%v", calls, err)
	}
}

// A recovered attachment may accept the write and then lose its response. The
// earlier rejection must never make that later unknown outcome look retry-safe.
func TestClaimAttachmentReconnectPreservesLostWriteResponse(t *testing.T) {
	for _, lost := range []error{io.ErrUnexpectedEOF, context.DeadlineExceeded} {
		t.Run(lost.Error(), func(t *testing.T) {
			calls, writes := 0, 0
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				if calls == 1 {
					return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader(`{"code":"native_attachment_unavailable"}`)), Header: http.Header{}}, nil
				}
				writes++
				return nil, lost
			})}}
			err := client.post(context.Background(), "claims/acquire", map[string]any{"client_request_id": "same"}, nil)
			var api *APIError
			if calls != 2 || writes != 1 || !errors.Is(err, lost) || errors.As(err, &api) {
				t.Fatalf("lost write replayed or stale rejection retained: calls=%d writes=%d err=%v", calls, writes, err)
			}
		})
	}
}
