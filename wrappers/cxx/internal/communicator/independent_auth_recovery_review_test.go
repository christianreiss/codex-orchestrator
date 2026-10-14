package communicator_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	comm "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	clx "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/lifecycle"
	ca "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	cdx "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/lifecycle"
	co "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestIndependentPendingFenceBlocksIdleStoreAfterRollback(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		t.Run(engine, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
			t.Setenv("CXX_COMMUNICATOR_SYNC", "")
			native := filepath.Join(home, ".codex", "auth.json")
			raw := []byte(`{"last_refresh":"` + time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano) + `","tokens":{"access_token":"private-fixture-access","refresh_token":"private-fixture-refresh"}}`)
			if engine == "claude" {
				native = filepath.Join(home, ".claude", ".credentials.json")
				raw = []byte(`{"claudeAiOauth":{"accessToken":"private-fixture-access","refreshToken":"private-fixture-refresh","expiresAt":4102444800000}}`)
			}
			if err := os.MkdirAll(filepath.Dir(native), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(native, raw, 0600); err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256(raw)
			marker, _ := json.Marshal(map[string]string{"generation": hex.EncodeToString(sum[:])})
			markerPath := filepath.Join(filepath.Dir(native), ".cxx-communicator-pending-auth.json")
			if err := os.WriteFile(markerPath, marker, 0600); err != nil {
				t.Fatal(err)
			}
			var stores atomic.Int32
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var in map[string]any
				_ = json.NewDecoder(r.Body).Decode(&in)
				if r.URL.Path == "/auth" && in["command"] == "store" {
					stores.Add(1)
				}
				w.WriteHeader(401)
				_, _ = w.Write([]byte(`{"code":"fixture-denied"}`))
			}))
			defer s.Close()
			if !comm.PendingAuth(s.URL, engine, native) {
				t.Fatal("reproduction requires live digest fence on disabled/no endpoint transport")
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if engine == "codex" {
				c, e := co.New(co.Options{BaseURL: s.URL, APIKey: "fixture"})
				if e != nil {
					t.Fatal(e)
				}
				_, _ = cdx.UploadAutomaticAuth(ctx, c, nil)
			} else {
				c, e := ca.New(ca.Options{BaseURL: s.URL, APIKey: "fixture"})
				if e != nil {
					t.Fatal(e)
				}
				_, _ = clx.UploadIdleAuth(ctx, c)
			}
			if n := stores.Load(); n != 0 {
				t.Errorf("unresolved interrupted candidate was automatically submitted after rollback: stores=%d", n)
			}
		})
	}
}

// The explicit command holds RecoveryFence from readback through backup, CAS
// and marker cleanup. An automatic helper must not enter that transaction on
// legacy transport, then must re-check the marker after acquiring the fence.
func TestAutomaticUploadCannotPassRecoveryFenceAfterRollback(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		t.Run(engine, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
			runtimeDir := t.TempDir()
			if err := os.Chmod(runtimeDir, 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("XDG_RUNTIME_DIR", runtimeDir)
			t.Setenv("CXX_COMMUNICATOR_SYNC", "")
			path := filepath.Join(home, ".codex", "auth.json")
			raw := []byte(`{"last_refresh":"` + time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano) + `","tokens":{"access_token":"fixture-access","refresh_token":"fixture-refresh"}}`)
			if engine == "claude" {
				path = filepath.Join(home, ".claude", ".credentials.json")
				raw = []byte(`{"claudeAiOauth":{"accessToken":"fixture-access","refreshToken":"fixture-refresh","expiresAt":4102444800000}}`)
			}
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			var stores atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var in map[string]any
				_ = json.NewDecoder(r.Body).Decode(&in)
				if r.URL.Path == "/auth" && in["command"] == "store" {
					stores.Add(1)
				}
				w.WriteHeader(401)
				_, _ = w.Write([]byte(`{"code":"fixture-denied"}`))
			}))
			defer server.Close()
			var upload func(context.Context) error
			if engine == "codex" {
				c, err := co.New(co.Options{BaseURL: server.URL, APIKey: "fixture"})
				if err != nil {
					t.Fatal(err)
				}
				upload = func(ctx context.Context) error { _, err := cdx.UploadAutomaticAuth(ctx, c, nil); return err }
			} else {
				c, err := ca.New(ca.Options{BaseURL: server.URL, APIKey: "fixture"})
				if err != nil {
					t.Fatal(err)
				}
				upload = func(ctx context.Context) error { _, err := clx.UploadIdleAuth(ctx, c); return err }
			}
			release, err := comm.RecoveryFence(context.Background(), server.URL, engine, path)
			if err != nil {
				t.Fatal(err)
			}
			defer release()
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			err = upload(ctx)
			cancel()
			if !errors.Is(err, context.DeadlineExceeded) || stores.Load() != 0 {
				t.Fatalf("automatic upload passed recovery: stores=%d error=%v", stores.Load(), err)
			}
			// A pending outcome established while recovery holds the scope must
			// be seen by the waiting/retried helper before any store is offered.
			sum := sha256.Sum256(raw)
			marker, _ := json.Marshal(map[string]string{"generation": hex.EncodeToString(sum[:])})
			if err := os.WriteFile(filepath.Join(filepath.Dir(path), ".cxx-communicator-pending-auth.json"), marker, 0600); err != nil {
				t.Fatal(err)
			}
			release()
			if err := upload(context.Background()); err == nil || stores.Load() != 0 {
				t.Fatalf("marker not rechecked after recovery: stores=%d error=%v", stores.Load(), err)
			}
			// A genuinely new native credential remains independently offerable.
			newNative := strings.Replace(string(raw), "fixture-access", "new-native-fixture-access", 1)
			if err := os.WriteFile(path, []byte(newNative), 0600); err != nil {
				t.Fatal(err)
			}
			_ = upload(context.Background())
			if stores.Load() != 1 {
				t.Fatal("automatic upload was disabled for independent native credentials")
			}
		})
	}
}
