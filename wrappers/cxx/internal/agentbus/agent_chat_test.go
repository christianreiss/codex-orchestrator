package agentbus

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestChatDownloadLargeChunkAndChecksum(t *testing.T) {
	content := strings.Repeat("image-fixture-", 240000) // Above the old 2 MiB response cap.
	hash := sha256.Sum256([]byte(content))
	for _, valid := range []bool{true, false} {
		t.Run(map[bool]string{true: "verified", false: "corrupt"}[valid], func(t *testing.T) {
			digest := hex.EncodeToString(hash[:])
			if !valid {
				digest = strings.Repeat("0", 64)
			}
			client := &sessionClient{id: "fixture", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				body, _ := json.Marshal(map[string]any{"content_b64": base64.StdEncoding.EncodeToString([]byte(content)), "done": true, "sha256": digest})
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body)))}, nil
			})}}
			result, err := callChatTool(context.Background(), client, "agent_attachment_get", map[string]any{"attachment_id": "11111111-1111-4111-8111-111111111111"})
			if !valid {
				if err == nil {
					t.Fatal("corrupt bytes accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			path := stringArg(result, "local_path")
			defer os.RemoveAll(strings.TrimSuffix(path, "/attachment"))
			bytes, err := os.ReadFile(path)
			if err != nil || string(bytes) != content {
				t.Fatalf("download differs: %v", err)
			}
			if _, ok := result["content_b64"]; ok {
				t.Fatal("base64 leaked to model")
			}
		})
	}
}

func TestChatUploadResumesAtPersistedOffset(t *testing.T) {
	file := t.TempDir() + "/sample.txt"
	if err := os.WriteFile(file, []byte("abcdef"), 0600); err != nil {
		t.Fatal(err)
	}
	var chunks int
	client := &sessionClient{id: "fixture", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := `{}`
		if strings.HasSuffix(req.URL.Path, "/attachments") {
			body = `{"uploaded_bytes":3}`
		}
		if strings.HasSuffix(req.URL.Path, "/chunks") {
			var payload map[string]any
			if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if intArg(payload, "offset", -1) != 3 || stringArg(payload, "content_b64") != base64.StdEncoding.EncodeToString([]byte("def")) {
				t.Fatalf("did not resume: %v", payload)
			}
			chunks++
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	if _, err := callChatTool(context.Background(), client, "agent_attachment_upload", map[string]any{"upload_id": "11111111-1111-4111-8111-111111111111", "path": file, "mime_type": "text/plain"}); err != nil {
		t.Fatal(err)
	}
	if chunks != 1 {
		t.Fatalf("got %d chunks", chunks)
	}
}

func TestRoomAttachmentUploadUsesAuthenticatedRoomRoute(t *testing.T) {
	file := t.TempDir() + "/note.txt"
	if err := os.WriteFile(file, []byte("room"), 0600); err != nil {
		t.Fatal(err)
	}
	room := "22222222-2222-4222-8222-222222222222"
	paths := []string{}
	client := &sessionClient{id: "fixture", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		paths = append(paths, req.URL.Path)
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"uploaded_bytes":0}`))}, nil
	})}}
	_, err := callChatTool(context.Background(), client, "agent_attachment_upload", map[string]any{"room_id": room, "upload_id": "11111111-1111-4111-8111-111111111111", "path": file, "mime_type": "text/plain"})
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 3 {
		t.Fatalf("expected create/chunk/seal, got %v", paths)
	}
	for _, path := range paths {
		if !strings.Contains(path, "/agent-messaging/chats/"+room+"/attachments") {
			t.Fatalf("room context lost: %s", path)
		}
	}
}

func TestPortalSayStaysNormalAndPreservesHeldInstruction(t *testing.T) {
	var sent []map[string]any
	client := &sessionClient{id: "launch", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/host/agent-sessions/launch/events" {
			t.Fatalf("unexpected route: %s", req.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		sent = append(sent, body)
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"stored":true}`))}, nil
	})}}
	tracker := newChannelTracker(client)
	tracker.receiver = &autoReceiver{client: client, pendingPortal: map[string]any{"message_id": "original"}}
	args := map[string]any{"client_event_id": "stable-update", "content": "Tests passed; integration continues.", "summary": strings.Repeat("x", 200), "reply_to": 42, "attachments": []string{"11111111-1111-4111-8111-111111111111"}, "severity": "important", "notice_id": "must-not-forward", "message_id": "original"}
	for range 2 {
		out := handleMCPRequest(context.Background(), client, ownerTool("agent_portal_say", args), false, tracker)
		raw, _ := json.Marshal(out)
		if strings.Contains(string(raw), `"isError":true`) {
			t.Fatal(string(raw))
		}
	}
	if len(sent) != 2 || sent[0]["client_event_id"] != "stable-update" || sent[1]["client_event_id"] != "stable-update" {
		t.Fatalf("retry identity lost: %v", sent)
	}
	for _, body := range sent {
		payload := body["payload"].(map[string]any)
		if body["type"] != "assistant_message" || payload["text"] != args["content"] || len([]rune(payload["summary"].(string))) != 160 || payload["reply_to"] != float64(42) || payload["attachments"] == nil {
			t.Fatalf("normal content lost: %v", body)
		}
		for _, key := range []string{"severity", "notice_id", "message_id"} {
			if _, exists := payload[key]; exists {
				t.Fatalf("ordinary update forwarded %s", key)
			}
		}
	}
	if tracker.receiver.pendingPortal == nil {
		t.Fatal("progress finished the held instruction")
	}
}

func TestPortalNotifyRetainsExplicitAttention(t *testing.T) {
	client := &sessionClient{id: "launch", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		payload := body["payload"].(map[string]any)
		if body["type"] != "attention" || payload["severity"] != "blocker" || payload["notice_id"] != "specific-notice" {
			t.Fatalf("explicit attention lost: %v", body)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}}
	if _, err := callChatTool(context.Background(), client, "agent_portal_notify", map[string]any{"client_event_id": "stable-alert", "summary": "Operator decision required.", "severity": "blocker", "notice_id": "specific-notice"}); err != nil {
		t.Fatal(err)
	}
}
