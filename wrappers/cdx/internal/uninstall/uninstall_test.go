package uninstall

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) (*orchestrator.Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	c, err := orchestrator.New(orchestrator.Options{BaseURL: srv.URL, APIKey: "sk-test"})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	t.Cleanup(srv.Close)
	return c, srv
}

func TestOtherUsersStripsCurrentAndDeduplicates(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/host/users" {
			t.Errorf("path = %q", r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["username"] != "alice" {
			t.Errorf("username forwarded = %v", body["username"])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok",
			"data": map[string]any{
				"users": []map[string]string{
					{"username": "alice"},
					{"username": "bob"},
					{"username": "bob"}, // dup
					{"username": ""},    // ignored
					{"username": "carol"},
				},
			},
		})
	})
	got := otherUsers(context.Background(), c, "alice")
	want := []string{"bob", "carol"}
	if len(got) != len(want) {
		t.Fatalf("got=%v want=%v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("got[%d]=%q want=%q", i, got[i], want[i])
		}
	}
}

func TestOtherUsersHonoursRootLevelUsersShape(t *testing.T) {
	// The envelope plugin spreads users to both root and data.users — make
	// sure we accept the root-level shape too.
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "ok",
			"users": []map[string]string{
				{"username": "dave"},
			},
		})
	})
	got := otherUsers(context.Background(), c, "alice")
	if len(got) != 1 || got[0] != "dave" {
		t.Errorf("got = %v", got)
	}
}

func TestOtherUsersReturnsEmptyOnNetworkError(t *testing.T) {
	c, srv := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	})
	srv.Close()
	got := otherUsers(context.Background(), c, "alice")
	if got != nil {
		t.Errorf("got = %v, want nil", got)
	}
}

func TestEnsureCanDestructivelyTouchOtherUsersRefusesWhenNonRootAndNoSudo(t *testing.T) {
	// Skip when running as root (CI containers): the refusal path is what
	// we're verifying, but root would short-circuit it.
	if isRoot() {
		t.Skip("test relies on non-root euid")
	}
	// We can't reliably guarantee sudo is unavailable in every CI; if the
	// test runner has passwordless sudo, the refusal won't fire.
	if sudoWorksNonInteractively() {
		t.Skip("passwordless sudo available — refusal path skipped")
	}
	var buf bytes.Buffer
	err := ensureCanDestructivelyTouchOtherUsers(&buf, []string{"bob"})
	if err == nil {
		t.Fatal("expected refusal error, got nil")
	}
	if buf.Len() == 0 {
		t.Errorf("expected message on stderr, got empty")
	}
}

func isRoot() bool {
	return os.Geteuid() == 0
}
