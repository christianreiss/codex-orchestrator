package projectfiles

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPutUploadsExactBinaryAndVerifiesReceiptAcrossEngines(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok", "kimi"} {
		t.Run(engine, func(t *testing.T) {
			raw := bytes.Repeat([]byte{0, 255, 9, 3}, 20<<10)
			sum := sha256.Sum256(raw)
			digest := hex.EncodeToString(sum[:])
			path := filepath.Join(t.TempDir(), "artifact.bin")
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/mcp" || r.Header.Get("X-API-Key") != "test" || r.Header.Get("Authorization") != "Bearer test" || r.Header.Get("X-Engine") != engine {
					t.Errorf("request=%s headers=%v", r.URL.Path, r.Header)
				}
				var body struct {
					Params struct {
						Name      string            `json:"name"`
						Arguments map[string]string `json:"arguments"`
					} `json:"params"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				uploaded, err := base64.StdEncoding.DecodeString(body.Params.Arguments["content"])
				if err != nil || !bytes.Equal(uploaded, raw) || body.Params.Name != "project_file_upsert" {
					t.Fatal("file bytes changed")
				}
				metadata, _ := json.Marshal(map[string]any{"project": "demo", "file": map[string]any{"id": 12, "stored_name": "artifact.bin", "size_bytes": len(raw), "content_sha256": digest, "content": body.Params.Arguments["content"]}})
				json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": "project-file-put", "result": map[string]any{"content": []any{map[string]any{"type": "text", "text": string(metadata)}}}})
			}))
			defer server.Close()
			got, err := put(context.Background(), server.Client(), server.URL, "test", options{slug: "demo", path: path, name: "artifact.bin", engine: engine})
			if err != nil {
				t.Fatal(err)
			}
			output, _ := json.Marshal(got)
			if strings.Contains(string(output), "content\"") || calls != 1 || got.File.SHA256 != digest {
				t.Fatalf("metadata=%s calls=%d", output, calls)
			}
		})
	}
}
func TestPutRefusesOversizedFileBeforeNetwork(t *testing.T) {
	path := filepath.Join(t.TempDir(), "large")
	if err := os.WriteFile(path, make([]byte, maxBytes+1), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := put(context.Background(), nil, "", "", options{path: path})
	if err == nil || !strings.Contains(err.Error(), "4 MiB") {
		t.Fatalf("error=%v", err)
	}
}
func TestPutRejectsIncorrectReceiptWithoutReplay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "small")
	os.WriteFile(path, []byte("local bytes"), 0600)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		io.WriteString(w, `{"id":"project-file-put","result":{"content":[{"type":"text","text":"{\"project\":\"demo\",\"file\":{\"stored_name\":\"small\",\"size_bytes\":11,\"content_sha256\":\"wrong\"}}"}]}}`)
	}))
	defer server.Close()
	_, err := put(context.Background(), server.Client(), server.URL, "test", options{slug: "demo", path: path, name: "small", engine: "codex"})
	if err == nil || calls != 1 {
		t.Fatalf("error=%v requests=%d", err, calls)
	}
}
func TestCommandEngineParityAndHelp(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok", "kimi"} {
		o, err := parse([]string{"file", "put", "demo", "/tmp/file", "--description", "text", "--stored-name", "report.bin", "--json"}, engine)
		if err != nil || o.engine != engine || o.name != "report.bin" {
			t.Fatalf("options=%+v err=%v", o, err)
		}
	}
	var out, errOut bytes.Buffer
	if code := Command([]string{"--help"}, "", &out, &errOut); code != 0 || !strings.Contains(out.String(), "project file put") {
		t.Fatalf("help=%s error=%s", out.String(), errOut.String())
	}
}
