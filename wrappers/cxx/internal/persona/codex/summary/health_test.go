package summary

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/ui"
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
	withCodexVersion(t, "1.0.0")
	got := Build(context.Background(), Inputs{WrapperVersion: "1.0.0", Auth: &orchestrator.AuthRetrieveResponse{Status: "valid"}})
	if got.ResultTone != ui.ToneOK || !strings.Contains(got.ResultLabel, "managed resources not checked") {
		t.Fatalf("unprobed resources = %q %q", got.ResultTone, got.ResultLabel)
	}
}

func TestQuotaBlockDoesNotHideAuthSyncFailure(t *testing.T) {
	withCodexVersion(t, "1.0.0")
	used := 100
	got := Build(context.Background(), Inputs{WrapperVersion: "1.0.0", AuthErr: errors.New("auth write failed"),
		Auth: &orchestrator.AuthRetrieveResponse{Status: "valid", QuotaHardFail: true, ChatGPT: &orchestrator.ChatGPTQuota{PrimaryUsed: &used}},
	})
	if got.ResultTone != ui.ToneFail || got.ResultLabel != "Sync failed: auth write failed." || got.QuotaBlock == "" {
		t.Fatalf("quota block hid auth failure: %q %q", got.ResultTone, got.ResultLabel)
	}
}
