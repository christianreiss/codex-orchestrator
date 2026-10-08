package agentbus

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func commandBroker(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "broker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	t.Cleanup(func() { _ = server.Close() })
	go func() { _ = server.Serve(listener) }()
	t.Setenv(envSocket, socket)
	t.Setenv(envSessionID, "fixture-session")
}

func TestCLIRequestPreservesCommittedSendWhenWaitFails(t *testing.T) {
	commandBroker(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/send") {
			_, _ = io.WriteString(w, `{"message":{"id":"stored","conversation_id":"conversation","sequence":1}}`)
		} else {
			http.Error(w, "wait failed", http.StatusServiceUnavailable)
		}
	})
	var out bytes.Buffer
	err := runSend([]string{"--to", "agent:peer", "--stdin", "--wait-seconds", "0"}, strings.NewReader("work"), &out, io.Discard, true)
	if err != nil {
		t.Fatalf("committed send hidden behind wait failure: %v", err)
	}
	var result map[string]any
	if json.Unmarshal(out.Bytes(), &result) != nil || result["sent"] == nil || result["wait_error"] == nil {
		t.Fatalf("missing send receipt and recovery guidance: %s", out.String())
	}
}

func TestCLIOneShotListenNeverClaimsWork(t *testing.T) {
	var informationOnly atomic.Bool
	commandBroker(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/deliveries/claim") {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			informationOnly.Store(body["informational_only"] == true)
		}
		_, _ = io.WriteString(w, `{}`)
	})
	if err := runListen([]string{"--seconds", "0"}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !informationOnly.Load() {
		t.Fatal("one-shot CLI advertised work execution without a surviving lease owner")
	}
}

func TestCLIMessageCommandsRetainRetryIDs(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	for _, command := range []string{"send", "request", "reply", "call-join"} {
		t.Run(command, func(t *testing.T) {
			commandBroker(t, func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["client_message_id"] != id {
					t.Errorf("retry ID changed: %v", body["client_message_id"])
				}
				http.Error(w, "uncertain receipt", http.StatusServiceUnavailable)
			})
			args := []string{"--stdin", "--client-message-id", id}
			var err error
			switch command {
			case "send", "request":
				err = runSend(append(args, "--to", "agent:peer"), strings.NewReader("body"), io.Discard, io.Discard, command == "request")
			case "reply":
				err = runReply(append(args, "--message-id", id), strings.NewReader("body"), io.Discard, io.Discard)
			case "call-join":
				err = runCallJoin(append(args, "--pin", "0042"), strings.NewReader("body"), io.Discard, io.Discard)
			}
			if err == nil || !strings.Contains(err.Error(), id) {
				t.Fatalf("retry guidance lost: %v", err)
			}
		})
	}
}
