package agentportal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestClaudeReceiverPreservesResumeAndUserSettings(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(envSocket, filepath.Join(dir, "portal.sock"))
	t.Setenv(envSessionID, "session")
	args := []string{"--continue", "--settings", `{"hooks":{"SessionStart":[]}}`, "--plugin-dir", "user-plugin"}
	got, err := ClaudeReceiverArgs(args)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got[:len(args)], args) {
		t.Fatal("changed native arguments")
	}
	for _, arg := range got {
		if arg == "--session-id" {
			t.Fatal("invented an identity for a resumed session")
		}
	}
	data, err := os.ReadFile(filepath.Join(dir, "receiver-plugin", "hooks", "hooks.json"))
	if err != nil {
		t.Fatal(err)
	}
	var hooks map[string]any
	if err := json.Unmarshal(data, &hooks); err != nil {
		t.Fatal(err)
	}
	if hooks["hooks"].(map[string]any)["SessionStart"] == nil {
		t.Fatal("missing native identity hook")
	}
}

func TestNativeIdentityIsLocalAndRequiresReceiverGrant(t *testing.T) {
	session := &Session{ID: "session", Engine: "claude", receiverAllowed: true}
	broker := &Broker{session: session}
	post := func(body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		broker.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/host/agent-sessions/session/receiver/native", strings.NewReader(body)))
		return recorder
	}
	if got := post(`{"native_session_id":"invalid"}`); got.Code != 400 {
		t.Fatalf("invalid identity: %d", got.Code)
	}
	const id = "11111111-1111-4111-8111-111111111111"
	if got := post(`{"native_session_id":"` + id + `"}`); got.Code != 200 {
		t.Fatalf("report: %d %s", got.Code, got.Body)
	}
	if got := post(`{}`); !strings.Contains(got.Body.String(), id) {
		t.Fatal("lost hook identity")
	}
	session.receiverAllowed = false
	if got := post(`{}`); got.Code != 403 {
		t.Fatalf("disabled grant: %d", got.Code)
	}
}
