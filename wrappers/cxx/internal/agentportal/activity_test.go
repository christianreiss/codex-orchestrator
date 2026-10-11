package agentportal

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClaudeHookEvidenceExpiresAndCannotCrossSessions(t *testing.T) {
	b := &Broker{session: &Session{Engine: "claude"}, nativeID: "native"}
	send := func(body string) ActivityObservation {
		t.Helper()
		w := httptest.NewRecorder()
		b.activityHook(w, []byte(body))
		if w.Code != 200 {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		var a ActivityObservation
		_ = json.Unmarshal(w.Body.Bytes(), &a)
		return a
	}
	if a := send(`{"native_session_id":"native","event":"UserPromptSubmit"}`); a.State != "working" {
		t.Fatal(a)
	}
	b.hookActivityAt = time.Now().Add(-46 * time.Second)
	if a := send(`{}`); a.State != "unknown" || a.EvidenceAgeMS < 46000 {
		t.Fatal(a)
	}
	if a := send(`{"native_session_id":"native","event":"PermissionRequest"}`); a.State != "waiting" || *a.WaitReason != "approval" {
		t.Fatal(a)
	}
	w := httptest.NewRecorder()
	b.activityHook(w, []byte(`{"native_session_id":"other","event":"Stop"}`))
	if w.Code != 409 {
		t.Fatal(w.Code)
	}
	b.nativeID = "other"
	if a := send(`{}`); a.State != "unknown" {
		t.Fatal(a)
	}
	if a := send(`{"native_session_id":"other","event":"UserPromptSubmit"}`); a.State != "working" {
		t.Fatal(a)
	}
	// A reporter from the previous native binding cannot read the new evidence.
	if a := send(`{"native_session_id":"native"}`); a.State != "unknown" {
		t.Fatal(a)
	}
}

func TestClaudeHookMetadataMapping(t *testing.T) {
	for event, want := range map[string]string{"PreToolUse": "working", "PostToolUse": "working", "PostToolUseFailure": "working", "Stop": "idle", "StopFailure": "idle", "SessionEnd": "unknown", "SessionStart": "unknown", "Elicitation": "waiting", "ElicitationResult": "working", "future": "unknown"} {
		if a := ClaudeActivity(ActivityHook{Event: event}); a.State != want {
			t.Fatalf("%s: %+v", event, a)
		}
	}
	if a := ClaudeActivity(ActivityHook{Event: "PreToolUse", Tool: "AskUserQuestion"}); a.State != "waiting" {
		t.Fatal(a)
	}
}
