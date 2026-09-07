package summary

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
)

func TestHealthUsesNormalizedAuthAndVerificationEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, status, verification string
		authErr                    error
		wantAPI, wantAuth          ui.Tone
	}{
		{name: "offline casing", status: " OFFLINE ", wantAPI: ui.ToneFail, wantAuth: ui.ToneFail},
		{name: "valid casing", status: " VALID ", verification: "verified", wantAPI: ui.ToneOK, wantAuth: ui.ToneOK},
		{name: "unknown verification", status: "valid", verification: "unknown", wantAPI: ui.ToneOK, wantAuth: ui.ToneWarn},
		{name: "pending verification", status: "valid", verification: "pending", wantAPI: ui.ToneOK, wantAuth: ui.ToneWarn},
		{name: "failed verification", status: "valid", verification: "failed", wantAPI: ui.ToneOK, wantAuth: ui.ToneFail},
		{name: "approval pending", status: "insecure_pending", wantAPI: ui.ToneOK, wantAuth: ui.ToneWarn},
		{name: "local write failure", status: "valid", verification: "verified", authErr: errors.New("auth write failed"), wantAPI: ui.ToneOK, wantAuth: ui.ToneFail},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dots := buildDots(&orchestrator.AuthRetrieveResponse{Status: tc.status, VerificationState: tc.verification}, Inputs{AuthSynced: true, AuthErr: tc.authErr, StatusOnly: true})
			if len(dots) != 2 || dots[0].Tone != tc.wantAPI || dots[1].Tone != tc.wantAuth {
				t.Fatalf("health evidence = %+v", dots)
			}
			if tc.wantAuth != ui.ToneOK && dots[1].Updated {
				t.Fatalf("unproven auth shown as successfully synced: %+v", dots[1])
			}
		})
	}
}

func TestUnprobedResourcesDoNotClaimAllSystemsOperational(t *testing.T) {
	withClaudeVersion(t, "1.0.0")
	got := Build(context.Background(), Inputs{WrapperVersion: "1.0.0", Auth: &orchestrator.AuthRetrieveResponse{Status: "valid"}})
	if got.ResultTone != ui.ToneOK || !strings.Contains(got.ResultLabel, "managed resources not checked") {
		t.Fatalf("unprobed resources = %q %q", got.ResultTone, got.ResultLabel)
	}
}

func TestPermissionBypassDoesNotHidePartialSync(t *testing.T) {
	withClaudeVersion(t, "1.0.0")
	got := Build(context.Background(), Inputs{WrapperVersion: "1.0.0", BypassPermissions: true,
		Auth:       &orchestrator.AuthRetrieveResponse{Status: "valid"},
		SkillsSync: ResourceSync{Checked: true, Err: errors.New("skill write failed")},
	})
	if got.ResultTone != ui.ToneWarn || !strings.Contains(got.ResultLabel, "resource sync incomplete") || !strings.Contains(got.ResultLabel, "Permission prompts bypassed") {
		t.Fatalf("permission badge hid partial sync: %q %q", got.ResultTone, got.ResultLabel)
	}
}
