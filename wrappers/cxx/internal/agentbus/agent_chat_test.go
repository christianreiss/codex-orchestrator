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
