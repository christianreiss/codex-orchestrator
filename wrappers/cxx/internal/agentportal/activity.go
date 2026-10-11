package agentportal

import (
	"encoding/json"
	"net/http"
	"time"
)

// ActivityObservation contains metadata only, never prompt or tool contents.
type ActivityObservation struct {
	State         string  `json:"state"`
	WaitReason    *string `json:"wait_reason"`
	Source        string  `json:"source"`
	EvidenceAgeMS int64   `json:"evidence_age_ms"`
}

type ActivityHook struct {
	NativeID string `json:"native_session_id"`
	Event    string `json:"event"`
	Tool     string `json:"tool,omitempty"`
}

func ClaudeActivity(h ActivityHook) ActivityObservation {
	a := ActivityObservation{State: "unknown", Source: "claude-hooks"}
	waiting := func(reason string) { a.State = "waiting"; a.WaitReason = &reason }
	switch h.Event {
	case "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "ElicitationResult":
		a.State = "working"
	case "PreToolUse":
		a.State = "working"
		if h.Tool == "AskUserQuestion" {
			waiting("input")
		}
	case "PermissionRequest":
		waiting("approval")
	case "Elicitation":
		waiting("input")
	case "Stop", "StopFailure":
		a.State = "idle"
	}
	return a
}

// The existing private broker is the hook collector. Hooks never wait on the server.
func (b *Broker) activityHook(w http.ResponseWriter, raw []byte) {
	var h ActivityHook
	if json.Unmarshal(raw, &h) != nil {
		writeBrokerError(w, 400, "activity_hook_invalid", "Invalid hook")
		return
	}
	b.nativeMu.Lock()
	defer b.nativeMu.Unlock()
	if h.Event != "" {
		if b.session.Engine != "claude" || h.NativeID == "" || h.NativeID != b.nativeID {
			writeBrokerError(w, 409, "activity_hook_stale", "Native identity changed")
			return
		}
		b.hookActivity = ClaudeActivity(h)
		b.hookActivityAt = time.Now()
		b.hookActivityNativeID = h.NativeID
	}
	a := b.hookActivity
	if b.hookActivityAt.IsZero() || b.hookActivityNativeID != b.nativeID || (h.NativeID != "" && h.NativeID != b.nativeID) {
		a = ActivityObservation{State: "unknown", Source: "claude-hooks"}
	} else {
		a.EvidenceAgeMS = time.Since(b.hookActivityAt).Milliseconds()
		if a.EvidenceAgeMS >= 45000 {
			a.State = "unknown"
			a.WaitReason = nil
		}
		if a.EvidenceAgeMS > 86400000 {
			a.EvidenceAgeMS = 86400000
		}
	}
	_ = json.NewEncoder(w).Encode(a)
}
