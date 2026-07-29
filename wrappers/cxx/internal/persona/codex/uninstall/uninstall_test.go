package uninstall

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
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

func TestAuthDeletePathIsCodexScoped(t *testing.T) {
	if got := authDeletePath(); got != "/auth?force=1&engine=codex" {
		t.Fatalf("authDeletePath() = %q", got)
	}
}

func TestRunRefusesWhileAnyAuthSessionIsActive(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	lease, err := codex.AcquireAuthSession()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _, _, _ = codex.FinishAuthSession(lease) }()
	var stdout, stderr bytes.Buffer
	err = Run(context.Background(), &config.Config{}, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "another cdx process") {
		t.Fatalf("Run error = %v", err)
	}
	if stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatalf("uninstall mutated state before maintenance proof: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestRequiredAuthCleanupAggregatesRemovalFailures(t *testing.T) {
	dir := t.TempDir()
	blockedAuth := filepath.Join(dir, "auth.json")
	blockedIntent := filepath.Join(dir, ".cdx-logout-intent.json")
	for _, path := range []string{blockedAuth, blockedIntent} {
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "block-remove"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	removable := filepath.Join(dir, ".cdx-insecure-purge-request")
	if err := os.WriteFile(removable, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	err := removeRequiredAuthState(&stdout, &stderr, []string{blockedAuth, blockedIntent, removable})
	if err == nil || !strings.Contains(err.Error(), "auth.json") || !strings.Contains(err.Error(), ".cdx-logout-intent.json") {
		t.Fatalf("aggregate cleanup error = %v", err)
	}
	if _, statErr := os.Stat(removable); !os.IsNotExist(statErr) {
		t.Fatalf("cleanup stopped after first failure: %v", statErr)
	}
	if !strings.Contains(stderr.String(), "auth.json") || !strings.Contains(stderr.String(), ".cdx-logout-intent.json") {
		t.Fatalf("cleanup failures not reported: %q", stderr.String())
	}
}

func TestRequiredAuthStateTargetsIncludeCanonicalProvenance(t *testing.T) {
	dir := t.TempDir()
	targets := requiredAuthStateTargets(dir)
	want := filepath.Join(dir, ".cdx-canonical-auth-generations.json")
	for _, target := range targets {
		if target == want {
			return
		}
	}
	t.Fatalf("required auth cleanup targets = %v, missing %s", targets, want)
}

func TestEnsureCanDestructivelyTouchOtherUsersRefusesWhenNonRootAndNoSudo(t *testing.T) {
	probeCalls := stubPrivilegeGate(t, 1000, false)
	var buf bytes.Buffer
	err := ensureCanDestructivelyTouchOtherUsers(context.Background(), &buf, []string{"bob"})
	if err == nil {
		t.Fatal("expected refusal error, got nil")
	}
	if !strings.Contains(buf.String(), "cdx --uninstall refused") || !strings.Contains(buf.String(), "bob") {
		t.Errorf("unexpected stderr: %q", buf.String())
	}
	if *probeCalls != 1 {
		t.Errorf("sudo probe calls = %d, want 1", *probeCalls)
	}
}

func TestRequireRootOrSudoAllowsPasswordlessSudo(t *testing.T) {
	probeCalls := stubPrivilegeGate(t, 1000, true)
	var buf bytes.Buffer
	if err := requireRootOrSudo(context.Background(), &buf, "test reason"); err != nil {
		t.Fatalf("requireRootOrSudo: %v", err)
	}
	if buf.Len() != 0 {
		t.Errorf("unexpected stderr: %q", buf.String())
	}
	if *probeCalls != 1 {
		t.Errorf("sudo probe calls = %d, want 1", *probeCalls)
	}
}

func TestRequireRootOrSudoAllowsRootWithoutSudoProbe(t *testing.T) {
	probeCalls := stubPrivilegeGate(t, 0, false)
	var buf bytes.Buffer
	if err := requireRootOrSudo(context.Background(), &buf, "test reason"); err != nil {
		t.Fatalf("requireRootOrSudo: %v", err)
	}
	if buf.Len() != 0 {
		t.Errorf("unexpected stderr: %q", buf.String())
	}
	if *probeCalls != 0 {
		t.Errorf("sudo probe calls = %d, want 0", *probeCalls)
	}
}

func stubPrivilegeGate(t *testing.T, uid int, sudoAvailable bool) *int {
	t.Helper()
	previousEffectiveUID := effectiveUID
	previousSudoProbe := sudoProbe
	probeCalls := 0
	effectiveUID = func() int { return uid }
	sudoProbe = func(context.Context) bool {
		probeCalls++
		return sudoAvailable
	}
	t.Cleanup(func() {
		effectiveUID = previousEffectiveUID
		sudoProbe = previousSudoProbe
	})
	return &probeCalls
}
