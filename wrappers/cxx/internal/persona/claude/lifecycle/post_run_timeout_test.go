package lifecycle

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
)

func TestPostRunWaitsForSlowVerification(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := claude.WriteAuth(json.RawMessage(`{"claudeAiOauth":{"accessToken":"new-login"}}`)); err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		select {
		case <-time.After(6 * time.Second):
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"updated","verification_state":"verified","host":{"secure":true}}`)
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	status, tone := maybePostRunAuthUpload(client, logger, claude.AuthGeneration{}, nil)
	if status != "uploaded" || tone != ui.ToneOK || requests.Load() != 1 {
		t.Fatalf("post-run = %q, %v; requests=%d", status, tone, requests.Load())
	}
}
