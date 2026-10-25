package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPublicationLostResponseExposesExactRetryIdentity(t *testing.T) {
	ids := map[string]bool{}
	calls, commits := 0, 0
	generated := ""
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		id := stringArg(body, "client_message_id")
		generated = id
		calls++
		if !ids[id] {
			ids[id] = true
			commits++
		}
		if calls == 1 {
			return nil, io.ErrUnexpectedEOF
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}}
	args := map[string]any{"topic": "group:ops", "content": "update"}
	_, err := callPublicationTool(context.Background(), client, "agent_publish", args)
	if err == nil || generated == "" || !strings.Contains(err.Error(), generated) {
		t.Fatalf("generated retry identity missing: %v", err)
	}
	args["client_message_id"] = generated
	if _, err := callPublicationTool(context.Background(), client, "agent_publish", args); err != nil {
		t.Fatal(err)
	}
	if calls != 2 || commits != 1 {
		t.Fatalf("same publication was committed again: calls=%d commits=%d", calls, commits)
	}
}

func TestUnknownControlOutcomeExposesGeneratedSendAndPublicationIdentity(t *testing.T) {
	for _, name := range []string{"agent_send", "agent_publish"} {
		t.Run(name, func(t *testing.T) {
			generated := ""
			client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				var body map[string]any
				_ = json.NewDecoder(req.Body).Decode(&body)
				generated = stringArg(body, "client_message_id")
				return &http.Response{StatusCode: 409, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"code":"communicator_outcome_unknown"}`))}, nil
			})}}
			_, err := callMCPTool(context.Background(), client, newChannelTracker(client), name, map[string]any{"to": "peer", "topic": "group:ops", "content": "update"})
			if generated == "" || err == nil || !strings.Contains(err.Error(), generated) {
				t.Fatalf("unknown mutation lost retry identity: %v", err)
			}
		})
	}
}

func TestPublicationCanceledBeforeDispatchDoesNotCommit(t *testing.T) {
	commits := 0
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if err := req.Context().Err(); err != nil {
			return nil, err
		}
		commits++
		return nil, io.ErrUnexpectedEOF
	})}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := callPublicationTool(ctx, client, "agent_publish", map[string]any{"topic": "group:ops", "content": "update"})
	if err == nil || commits != 0 {
		t.Fatalf("canceled publication committed: err=%v commits=%d", err, commits)
	}
}

func TestPublicationDefiniteRejectionDoesNotSuggestUnchangedRetry(t *testing.T) {
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 403, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"code":"publication_forbidden"}`))}, nil
	})}}
	_, err := callPublicationTool(context.Background(), client, "agent_publish", map[string]any{"topic": "group:ops", "content": "update"})
	if err == nil || strings.Contains(err.Error(), "retry the same") {
		t.Fatalf("definite rejection suggested replay: %v", err)
	}
}
