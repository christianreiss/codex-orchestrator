package transfers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
)

// ownerStub serves a local owner's /_comm/status body and reads it the way
// communicator.OwnerStatus does; an empty body means no owner answers.
func ownerStub(t *testing.T, body string) func(context.Context, string) (communicator.Owner, bool) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if body == "" || r.URL.Path != "/_comm/status" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return func(ctx context.Context, _ string) (communicator.Owner, bool) {
		req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/_comm/status", nil)
		res, err := srv.Client().Do(req)
		if err != nil {
			return communicator.Owner{}, false
		}
		defer res.Body.Close()
		var o communicator.Owner
		if res.StatusCode != 200 || json.NewDecoder(res.Body).Decode(&o) != nil || o.Version == "" {
			return communicator.Owner{}, false
		}
		return o, true
	}
}

// countingClient answers every API request with a transport error and counts
// it, so a test can tell whether the upload got past the preflight.
func countingClient(requests *atomic.Int32) *Client {
	return &Client{HTTP: &http.Client{Transport: transportFunc(func(*http.Request) (*http.Response, error) {
		requests.Add(1)
		return nil, fmt.Errorf("offline")
	})}, BaseURL: "https://fleet.example", APIKey: "test", Engine: "codex"}
}

func sparseFile(t *testing.T, size int64) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "large.bin")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Truncate(size); err != nil {
		t.Fatal(err)
	}
	f.Close()
	return path
}

// On host 32 a resident 0.9.83 owner refused every 16 MiB chunk with a bare
// "transfer HTTP 413: " after the record and journal already existed.
func TestStaleOwnerRefusesLargeUploadBeforeAnyRecord(t *testing.T) {
	var requests atomic.Int32
	c := countingClient(&requests)
	c.Owner = ownerStub(t, `{"protocol":1,"version":"0.9.83","pid":4242,"mode":"resident","connected":true}`)
	path := sparseFile(t, ownerBodyLimit+1)
	_, err := c.Put(context.Background(), path, 600, false)
	var refused *OwnerError
	if !errors.As(err, &refused) {
		t.Fatalf("want OwnerError, got %v", err)
	}
	for _, want := range []string{"cxx 0.9.83", "pid 4242", "8 MiB", "0.9.93"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q lacks %q", err, want)
		}
	}
	if requests.Load() != 0 {
		t.Fatalf("refused upload sent %d requests", requests.Load())
	}
	if _, e := os.Stat(path + ".cxx-upload.json"); !os.IsNotExist(e) {
		t.Fatal("refused upload wrote a journal")
	}
	var stdout, stderr bytes.Buffer
	reportFailure(err, true, &stdout, &stderr)
	var out map[string]any
	if e := json.Unmarshal(stdout.Bytes(), &out); e != nil {
		t.Fatalf("json output %q: %v", stdout.String(), e)
	}
	remedy, _ := out["remedy"].(string)
	if out["error"] != err.Error() || out["outcome"] != "not_started" || out["owner_version"] != "0.9.83" || out["owner_pid"] != float64(4242) ||
		out["owner_mode"] != "resident" || out["required_version"] != "0.9.93" || !strings.Contains(remedy, "sudo cxx daemon install") {
		t.Fatalf("json refusal %v", out)
	}
	if _, has := out["id"]; has {
		t.Fatal("refusal names a transfer ID that was never created")
	}
	if !strings.Contains(stderr.String(), "sudo cxx daemon install") {
		t.Fatalf("stderr lacks remedy: %s", stderr.String())
	}
	// --resume is refused the same way.
	if _, err = c.Put(context.Background(), path, 600, true); !errors.As(err, &refused) {
		t.Fatalf("resume through stale owner: %v", err)
	}
	c.Owner = ownerStub(t, `{"version":"0.9.90","pid":77,"mode":"on_demand"}`)
	if _, err = c.Put(context.Background(), path, 600, false); !errors.As(err, &refused) || !strings.Contains(refused.Remedy(), "owner PID 77") || !strings.Contains(refused.Remedy(), "across the whole owner") || strings.Contains(refused.Remedy(), "kill ") {
		t.Fatalf("on-demand stale owner: %v", err)
	}
}

// Only a release known to refuse the upload stops it: a current owner, an
// unreadable or unversioned one, and a body the old owner still buffers all
// proceed to the server exactly as before.
func TestOwnerPreflightProceedsUnlessRefusalIsKnown(t *testing.T) {
	large := ownerBodyLimit + 1
	for _, c := range []struct {
		name, status string
		size         int64
	}{
		{"current owner", `{"version":"0.9.93","pid":1,"mode":"on_demand"}`, large},
		{"newer owner", `{"version":"0.9.120","pid":1,"mode":"resident"}`, large},
		{"no owner", "", large},
		{"old status format", `{"protocol":1}`, large},
		{"dev build", `{"version":"dev","pid":1}`, large},
		{"small file on old owner", `{"version":"0.9.83","pid":1,"mode":"resident"}`, ownerBodyLimit},
	} {
		t.Run(c.name, func(t *testing.T) {
			var requests atomic.Int32
			client := countingClient(&requests)
			client.Owner = ownerStub(t, c.status)
			path := sparseFile(t, c.size)
			_, err := client.Put(context.Background(), path, 600, false)
			var put *PutError
			if !errors.As(err, &put) || requests.Load() == 0 {
				t.Fatalf("upload did not reach the server: %v (requests %d)", err, requests.Load())
			}
		})
	}
	var requests atomic.Int32
	direct := countingClient(&requests)
	if _, err := direct.Put(context.Background(), sparseFile(t, large), 600, false); requests.Load() == 0 {
		t.Fatalf("direct client without owner hook did not proceed: %v", err)
	}
}

// http.Error from an old owner is plain text; the CLI used to print an empty
// "transfer HTTP 413: ".
func TestErrorBodyFallsBackToPlainText(t *testing.T) {
	for _, c := range []struct {
		name, contentType, body, want string
	}{
		{"owner 413", "text/plain; charset=utf-8", "communicator request too large\n", "transfer HTTP 413: communicator request too large"},
		{"json message", "application/json", `{"message":"quota exceeded"}`, "transfer HTTP 413: quota exceeded"},
		{"json error", "application/json", `{"error":{"message":"too big"}}`, "transfer HTTP 413: too big"},
		{"control chars", "text/plain", "line one\r\n\x1b[31mline\ttwo\x00", "transfer HTTP 413: line one [31mline two"},
		{"long body", "text/html", strings.Repeat("x", 500), "transfer HTTP 413: " + strings.Repeat("x", 200)},
	} {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", c.contentType)
				w.WriteHeader(413)
				io.WriteString(w, c.body)
			}))
			defer srv.Close()
			client := &Client{HTTP: srv.Client(), BaseURL: srv.URL, APIKey: "test", Engine: "codex"}
			_, err := client.Put(context.Background(), source(t), 600, false)
			if err == nil || err.Error() != c.want {
				t.Fatalf("got %v, want %q", err, c.want)
			}
		})
	}
}
