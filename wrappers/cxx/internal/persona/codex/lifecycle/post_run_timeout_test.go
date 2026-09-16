package lifecycle

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/ui"
)

func TestPostRunWaitsForSlowVerification(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	path, _ := codex.AuthPath()
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"new-login"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		// A healthy native runner can need more than five seconds while still
		// completing inside its eight-second probe budget.
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
	status, tone, err := maybePostRunAuthUpload(client, logger, path, "", "")
	if err != nil || status != "uploaded" || tone != ui.ToneOK || requests.Load() != 1 {
		t.Fatalf("post-run = %q, %v, %v; requests=%d", status, tone, err, requests.Load())
	}
	generation, err := codex.CurrentAuthGeneration()
	if err != nil {
		t.Fatal(err)
	}
	if acknowledged, err := codex.IsCanonicalAuthGeneration(generation); err != nil || !acknowledged {
		t.Fatalf("accepted credential acknowledgement = %v, %v", acknowledged, err)
	}
}
