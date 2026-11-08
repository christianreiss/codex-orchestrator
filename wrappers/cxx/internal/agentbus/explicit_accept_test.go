package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

const explicitMessage = "11111111-1111-4111-8111-111111111111"
const explicitClaim = "22222222-2222-4222-8222-222222222222"

func explicitFixture(t *testing.T, handle func(*http.Request) (*http.Response, error)) (*sessionClient, *channelTracker, context.Context) {
	t.Helper()
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(handle)}}
	tracker := newChannelTracker(client)
	tracker.receiver = &autoReceiver{client: client, tracker: tracker, connected: true, lastBeatOK: time.Now(), sources: []string{"peer"}, generation: "generation", connectionOwned: true}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return client, tracker, ctx
}
func explicitResponse(body string) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
}
func explicitArgs() map[string]any {
	return map[string]any{"message_id": explicitMessage, "claim_id": explicitClaim}
}

func TestExplicitAcceptRetainsLostAcceptanceWithoutNativeSubmission(t *testing.T) {
	claims, acks := 0, 0
	client, state, ctx := explicitFixture(t, func(req *http.Request) (*http.Response, error) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		if strings.HasSuffix(req.URL.Path, "/deliveries/claim") {
			claims++
			if body["message_id"] != explicitMessage || body["claim_id"] != explicitClaim || body["receiver_generation"] != "generation" || body["wait_seconds"] != float64(0) {
				t.Fatalf("wrong targeted claim: %v", body)
			}
			return explicitResponse(`{"delivery":{"message_id":"` + explicitMessage + `","work_kind":"request","content":"authorized work"}}`)
		}
		acks++
		if body["claim_id"] != explicitClaim || body["outcome"] != "accepted" {
			t.Fatalf("wrong acknowledgement: %v", body)
		}
		if acks <= 2 {
			return nil, io.ErrUnexpectedEOF
		}
		return explicitResponse(`{"message":{"status":"accepted"}}`)
	})
	unrelated := state.track(ctx, "information", "info-claim", map[string]any{"kind": "message"})
	out, err := agentAccept(ctx, client, state, explicitArgs())
	if err == nil || out != nil {
		t.Fatal("lost acceptance exposed work")
	}
	pending := state.get(explicitMessage)
	if pending == nil || !pending.admissionPending() {
		t.Fatal("lost original acceptance ownership")
	}
	if len(state.admissionIDs()) != 0 {
		t.Fatal("explicit acceptance entered background native admissions")
	}
	if err := state.receiver.reconcileAdmission(ctx, explicitMessage, pending); err != nil {
		t.Fatal(err)
	}
	if acks != 2 {
		t.Fatal("background admission retried explicit work")
	}
	out, err = agentAccept(ctx, client, state, explicitArgs())
	if err != nil || out["status"] != "accepted" || claims != 1 || acks != 3 || pending.admissionPending() {
		t.Fatalf("failed same-claim retry: %v %v claims=%d acks=%d", out, err, claims, acks)
	}
	if state.get("information") != unrelated {
		t.Fatal("completed unrelated information")
	}
	if _, err = agentAccept(ctx, client, state, explicitArgs()); err != nil || claims != 1 || acks != 4 {
		t.Fatal("lost tool response cannot retry accepted receipt", err)
	}
}

func TestExplicitAcceptLostClaimRefusesNewIdentity(t *testing.T) {
	calls := 0
	client, state, ctx := explicitFixture(t, func(req *http.Request) (*http.Response, error) { calls++; return nil, io.ErrUnexpectedEOF })
	if _, err := agentAccept(ctx, client, state, explicitArgs()); err == nil {
		t.Fatal("expected lost response")
	}
	args := explicitArgs()
	args["claim_id"] = "33333333-3333-4333-8333-333333333333"
	if _, err := agentAccept(ctx, client, state, args); err == nil || calls != 1 {
		t.Fatal("replaced uncertain claim")
	}
}

func TestExplicitAcceptRejectsWrongDeliveryAndRequiresReceiver(t *testing.T) {
	for _, body := range []string{`{"delivery":null}`, `{"delivery":{"message_id":"wrong","work_kind":"request"}}`, `{"delivery":{"message_id":"` + explicitMessage + `","work_kind":"schedule"}}`} {
		t.Run(body, func(t *testing.T) {
			calls := 0
			client, state, ctx := explicitFixture(t, func(req *http.Request) (*http.Response, error) { calls++; return explicitResponse(body) })
			if out, err := agentAccept(ctx, client, state, explicitArgs()); err == nil || out != nil || calls != 1 {
				t.Fatalf("unexpected acceptance %v %v", out, err)
			}
		})
	}
	client, state, ctx := explicitFixture(t, func(req *http.Request) (*http.Response, error) {
		t.Fatal("unready receiver dispatched")
		return nil, nil
	})
	state.receiver.connected = false
	if _, err := agentAccept(ctx, client, state, explicitArgs()); err == nil {
		t.Fatal("accepted without receiver")
	}
}

func TestExplicitAcceptCannotReplaceTrackedDelivery(t *testing.T) {
	client, state, ctx := explicitFixture(t, func(req *http.Request) (*http.Response, error) {
		t.Fatal("existing ownership dispatched another claim")
		return nil, nil
	})
	held := state.track(ctx, explicitMessage, "original-claim", map[string]any{"work_kind": "request"})
	if _, err := agentAccept(ctx, client, state, explicitArgs()); err == nil {
		t.Fatal("replaced existing delivery")
	}
	if state.get(explicitMessage) != held {
		t.Fatal("lost original tracked delivery")
	}
}
