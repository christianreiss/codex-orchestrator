package lifecycle

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
)

func TestPostRunUploadRetriesTransientFailureBeforeFinalInsecureCleanup(t *testing.T) {
	for _, recovery := range []bool{true, false} {
		t.Run(fmt.Sprint(recovery), func(t *testing.T) {
			path, _ := sessionFixture(t)
			before, _ := claude.ReadAuthSnapshot(false)
			native := sessionPayload("rotated", time.Now())
			_ = os.WriteFile(path, native, 0o600)
			session, err := claude.StartAuthSession(true)
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			var calls atomic.Int32
			client := sessionClient(t, func(w http.ResponseWriter, _ *http.Request) {
				call := calls.Add(1)
				if !recovery || call == 1 {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				_, _ = fmt.Fprintf(w, `{"status":"updated","verification_state":"verified","canonical_digest":%q}`, strings.Repeat("d", 64))
			})
			status, tone := maybePostRunAuthUpload(client, slog.New(slog.DiscardHandler), before.Generation, session)
			if recovery && (status != "uploaded" || tone != ui.ToneOK || calls.Load() != 2) {
				t.Fatalf("recovery status=%s tone=%v calls=%d", status, tone, calls.Load())
			}
			if !recovery && (status != "upload failed" || tone != ui.ToneFail || calls.Load() != 6) {
				t.Fatalf("failed upload hidden: %s %v attempts=%d", status, tone, calls.Load())
			}
			if raw, _ := os.ReadFile(path); string(raw) != string(native) {
				t.Fatal("upload attempt discarded pending native credentials")
			}
			if purged, err := session.CloseAndPurgeIfLast(); err != nil || !purged {
				t.Fatalf("mandatory insecure cleanup weakened: %v %v", purged, err)
			}
		})
	}
}

func TestPostRunUnchangedUnsentOfflineCandidateStillRequiresUpload(t *testing.T) {
	for _, bound := range []bool{false, true} {
		t.Run(fmt.Sprint(bound), func(t *testing.T) {
			path, _ := sessionFixture(t)
			if !bound {
				_ = os.WriteFile(path, sessionPayload("offline-unsent", time.Now()), 0o600)
			}
			before, _ := claude.ReadAuthSnapshot(false)
			session, err := claude.StartAuthSession(true)
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			var calls atomic.Int32
			client := sessionClient(t, func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.WriteHeader(http.StatusServiceUnavailable)
			})
			status, tone := maybePostRunAuthUpload(client, slog.New(slog.DiscardHandler), before.Generation, session)
			if bound && (status != "unchanged" || tone != ui.ToneOK || calls.Load() != 0) {
				t.Fatalf("bound unchanged generation reuploaded: %s %v requests=%d", status, tone, calls.Load())
			}
			if !bound && (status != "upload failed" || tone != ui.ToneFail || calls.Load() != 6) {
				t.Fatalf("unsent generation misreported: %s %v requests=%d", status, tone, calls.Load())
			}
			if purged, err := session.CloseAndPurgeIfLast(); err != nil || !purged {
				t.Fatalf("insecure cleanup changed: %v %v", purged, err)
			}
		})
	}
}
