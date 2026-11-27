package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
)

// deadTokenClear is the record Claude Code writes after invalid_grant: the
// login block stays, both tokens are blanked and expiresAt is zero.
const deadTokenClear = `{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,"accountUuid":"acct-a","refreshTokenExpiresAt":1798214052191,"scopes":["user:inference"]}}`

func canonicalWithExpiry(token, account string, expires time.Time) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"last_refresh":%q,"claudeAiOauth":{"accessToken":%q,"refreshToken":"rotated-refresh","expiresAt":%d,"accountUuid":%q}}`,
		time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano), token, expires.UnixMilli(), account))
}

func deadTokenFixture(t *testing.T) string {
	t.Helper()
	path, _ := sessionFixture(t)
	if err := os.WriteFile(path, []byte(deadTokenClear), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// A host that lost the refresh race to another host holds Claude Code's
// dead-token clear; the verified generation that won must replace it during
// the running session instead of the sync deferring forever.
func TestSessionAuthHealsDeadTokenClearWithFreshVerifiedCanonical(t *testing.T) {
	path := deadTokenFixture(t)
	winner := canonicalWithExpiry("winner-access", "acct-a", time.Now().Add(8*time.Hour))
	client := sessionClient(t, func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		if body["command"] != "retrieve" || body["digest"] != nil || body["auth"] != nil {
			t.Errorf("dead-token heal must be a digest-less retrieve, got %v", body)
		}
		canonicalSessionResponse(w, winner, "verified")
	})
	result, err := SyncSessionAuth(context.Background(), client, nil)
	if err != nil || !result.Adopted || result.Uploaded || result.Deferred {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `"winner-access"`) || !claude.HasUsableAuth() {
		t.Fatalf("dead-token clear was not replaced: %s", raw)
	}
}

func TestSessionAuthKeepsDeadTokenClearUntilAFreshCanonicalArrives(t *testing.T) {
	cases := map[string]struct {
		auth         json.RawMessage
		verification string
		want         error
	}{
		// The canonical is still the pair whose refresh just failed: adopting
		// it would make Claude Code replay the spent refresh token at once.
		"spent-pair-near-expiry": {canonicalWithExpiry("spent", "acct-a", time.Now().Add(3*time.Minute)), "verified", ErrDeadTokenAwaitingCanonical},
		"other-claude-account":   {canonicalWithExpiry("other", "acct-b", time.Now().Add(8*time.Hour)), "verified", ErrDeadTokenAwaitingCanonical},
		"unverified":             {canonicalWithExpiry("pending", "acct-a", time.Now().Add(8*time.Hour)), "pending", ErrSessionAuthUnverified},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			path := deadTokenFixture(t)
			client := sessionClient(t, func(w http.ResponseWriter, _ *http.Request) {
				canonicalSessionResponse(w, tc.auth, tc.verification)
			})
			result, err := SyncSessionAuth(context.Background(), client, nil)
			if !errors.Is(err, tc.want) || result.Adopted {
				t.Fatalf("result=%+v err=%v, want %v", result, err, tc.want)
			}
			raw, _ := os.ReadFile(path)
			if string(raw) != deadTokenClear {
				t.Fatalf("dead-token clear changed: %s", raw)
			}
		})
	}
}

// An explicit logout is never resurrected, even over a dead-token clear.
func TestSessionAuthDeadTokenHealHonoursLogoutIntent(t *testing.T) {
	path := deadTokenFixture(t)
	snap, _ := claude.ReadAuthSnapshot(false)
	if _, err := claude.RecordDeferredExplicitLogout(snap.Generation); err != nil {
		t.Fatal(err)
	}
	client := sessionClient(t, func(w http.ResponseWriter, _ *http.Request) {
		canonicalSessionResponse(w, canonicalWithExpiry("winner", "acct-a", time.Now().Add(8*time.Hour)), "verified")
	})
	result, _ := SyncSessionAuth(context.Background(), client, nil)
	if result.Adopted {
		t.Fatalf("logout resurrected: %+v", result)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != deadTokenClear {
		t.Fatalf("logged-out credentials rewritten: %s", raw)
	}
}

// The legacy watcher used to skip every unusable snapshot, so a dead-token
// clear never reached the pull.
func TestAuthWatcherPullsOverDeadTokenClear(t *testing.T) {
	deadTokenFixture(t)
	var pulls, uploads atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	deps := authWatchDeps{
		snapshotContext: func(c context.Context) (claude.AuthSnapshot, error) { return claude.ReadAuthSnapshotContext(c, false) },
		upload:          func(context.Context) (claude.AuthSnapshot, error) { uploads.Add(1); return claude.AuthSnapshot{}, nil },
		pull: func(context.Context) (claude.AuthSnapshot, error) {
			if pulls.Add(1) >= 1 {
				cancel()
			}
			return claude.AuthSnapshot{}, nil
		},
		interval: 5 * time.Millisecond, pullInterval: time.Hour, backoff: time.Millisecond, maxBackoff: time.Millisecond, timeout: time.Second,
		logger: slog.New(slog.DiscardHandler),
	}
	done := make(chan struct{})
	go func() { runAuthUploadWatcher(ctx, deps, claude.AuthGeneration{}); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		cancel()
		<-done
		t.Fatal("watcher never pulled over a dead-token clear")
	}
	if pulls.Load() == 0 || uploads.Load() != 0 {
		t.Fatalf("pulls=%d uploads=%d", pulls.Load(), uploads.Load())
	}
}
