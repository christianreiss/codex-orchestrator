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

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
)

func TestRemoveFleetSkillsRemovesManifestDirsOnly(t *testing.T) {
	home := t.TempDir()
	manPath := filepath.Join(home, ".clx", "state", "collections", "skills.json")
	if err := os.MkdirAll(filepath.Dir(manPath), 0o755); err != nil {
		t.Fatal(err)
	}
	man := `{"version":1,"items":{"a":{"filename":"a/SKILL.md","sha256":"1"}}}`
	if err := os.WriteFile(manPath, []byte(man), 0o644); err != nil {
		t.Fatal(err)
	}
	skills := filepath.Join(home, ".claude", "skills")
	for _, s := range []string{"a", "keep"} {
		if err := os.MkdirAll(filepath.Join(skills, s), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(skills, s, "SKILL.md"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var out, errb bytes.Buffer
	removeFleetSkills(home, &out, &errb)
	if _, err := os.Stat(filepath.Join(skills, "a")); !os.IsNotExist(err) {
		t.Fatalf("fleet skill dir a/ must be removed, stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(skills, "keep", "SKILL.md")); err != nil {
		t.Fatalf("user skill dir keep/ must survive: %v", err)
	}
}

func TestRemoveLocalStateReturnsCredentialRemovalFailure(t *testing.T) {
	home := t.TempDir()
	blocked := filepath.Join(home, ".claude", ".credentials.json")
	if err := os.MkdirAll(blocked, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(blocked, "still-in-use"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	err := removeLocalState(home, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), ".credentials.json") {
		t.Fatalf("credential removal failure=%v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), ".credentials.json") {
		t.Fatalf("credential removal failure was not reported: %q", stderr.String())
	}
}

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
					{"username": "bob"},
					{"username": ""},
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

// The compatibility helper still collapses errors, while Run uses
// otherUsersOrErr and requires root/passwordless sudo when enumeration fails.
func TestOtherUsersReturnsEmptyOnNetworkError(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	if got := otherUsers(context.Background(), c, "alice"); len(got) != 0 {
		t.Fatalf("network error must yield no other users (fail-open), got %v", got)
	}
}

func TestOtherUsersOrErrPropagatesNetworkError(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	if _, err := otherUsersOrErr(context.Background(), c, "alice"); err == nil {
		t.Fatal("host-user lookup failure was swallowed")
	}
}

func TestEnsureCanDestructivelyTouchOtherUsersRefusesWhenNonRootAndNoSudo(t *testing.T) {
	probeCalls := stubPrivilegeGate(t, 1000, false)
	var buf bytes.Buffer
	err := ensureCanDestructivelyTouchOtherUsers(context.Background(), &buf, []string{"bob"})
	if err == nil {
		t.Fatal("expected refusal error, got nil")
	}
	if !strings.Contains(buf.String(), "clx --uninstall refused") || !strings.Contains(buf.String(), "bob") {
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
