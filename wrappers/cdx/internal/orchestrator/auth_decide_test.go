package orchestrator

import (
	"strings"
	"testing"
	"time"
)

func TestDecide_TableDriven(t *testing.T) {
	type wantD struct {
		allowed bool
		poll    bool
		local   bool
		reason  string // substring match; empty = no expectation
	}
	probeValid := LocalAuthProbe{
		IsValid: func(string) bool { return true },
		IsFresh: func(string, time.Duration) (bool, error) { return true, nil },
	}
	probeInvalid := LocalAuthProbe{
		IsValid: func(string) bool { return false },
		IsFresh: func(string, time.Duration) (bool, error) { return false, nil },
	}
	probeFresh24Only := LocalAuthProbe{
		IsValid: func(string) bool { return true },
		IsFresh: func(_ string, w time.Duration) (bool, error) { return w <= MaxLocalAuthAge, nil },
	}
	probeFresh7Only := LocalAuthProbe{
		IsValid: func(string) bool { return true },
		IsFresh: func(_ string, w time.Duration) (bool, error) { return w == MaxLocalAuthRecent, nil },
	}

	cases := []struct {
		name   string
		resp   *AuthRetrieveResponse
		path   string
		secure bool
		probe  LocalAuthProbe
		want   wantD
	}{
		{name: "valid", resp: &AuthRetrieveResponse{Status: "valid"}, want: wantD{allowed: true}},
		{name: "current", resp: &AuthRetrieveResponse{Status: "current"}, want: wantD{allowed: true}},
		{name: "ok", resp: &AuthRetrieveResponse{Status: "ok"}, want: wantD{allowed: true}},
		{name: "unchanged", resp: &AuthRetrieveResponse{Status: "unchanged"}, want: wantD{allowed: true}},
		{name: "updated", resp: &AuthRetrieveResponse{Status: "updated"}, want: wantD{allowed: true}},
		{name: "outdated", resp: &AuthRetrieveResponse{Status: "outdated"}, want: wantD{allowed: true}},
		{name: "missing", resp: &AuthRetrieveResponse{Status: "missing"}, want: wantD{allowed: true, reason: "missing"}},
		{name: "upload_required", resp: &AuthRetrieveResponse{Status: "upload_required"}, want: wantD{allowed: true, reason: "upload"}},
		{
			name: "verification failed overrides green status",
			resp: &AuthRetrieveResponse{Status: "outdated", VerificationState: "failed"},
			want: wantD{reason: "failed live verification"},
		},
		{
			name: "verification failed but newer local login launches locally",
			resp: &AuthRetrieveResponse{
				Status:               "outdated",
				VerificationState:    "failed",
				CanonicalLastRefresh: time.Now().UTC().Add(-30 * 24 * time.Hour).Format(time.RFC3339),
			},
			path: "/dev/null",
			probe: LocalAuthProbe{
				IsValid:     func(string) bool { return true },
				LastRefresh: func(string) (time.Time, error) { return time.Now().UTC().Add(-time.Hour), nil },
			},
			want: wantD{allowed: true, local: true, reason: "newer local auth.json"},
		},
		{
			name: "verification failed with older local still refuses",
			resp: &AuthRetrieveResponse{
				Status:               "outdated",
				VerificationState:    "failed",
				CanonicalLastRefresh: time.Now().UTC().Add(-time.Hour).Format(time.RFC3339),
			},
			path: "/dev/null",
			probe: LocalAuthProbe{
				IsValid:     func(string) bool { return true },
				LastRefresh: func(string) (time.Time, error) { return time.Now().UTC().Add(-30 * 24 * time.Hour), nil },
			},
			want: wantD{reason: "failed live verification"},
		},
		{
			name: "verification failed with equal stamps refuses (local IS the canonical)",
			resp: &AuthRetrieveResponse{
				Status:               "outdated",
				VerificationState:    "failed",
				CanonicalLastRefresh: "2026-06-08T15:26:33Z",
			},
			path: "/dev/null",
			probe: LocalAuthProbe{
				IsValid: func(string) bool { return true },
				LastRefresh: func(string) (time.Time, error) {
					return time.Date(2026, 6, 8, 15, 26, 33, 0, time.UTC), nil
				},
			},
			want: wantD{reason: "failed live verification"},
		},
		{
			name: "verification failed with invalid local refuses",
			resp: &AuthRetrieveResponse{
				Status:               "outdated",
				VerificationState:    "failed",
				CanonicalLastRefresh: time.Now().UTC().Add(-30 * 24 * time.Hour).Format(time.RFC3339),
			},
			path: "/dev/null",
			probe: LocalAuthProbe{
				IsValid:     func(string) bool { return false },
				LastRefresh: func(string) (time.Time, error) { return time.Now().UTC(), nil },
			},
			want: wantD{reason: "failed live verification"},
		},
		{
			name: "verification verified allows",
			resp: &AuthRetrieveResponse{Status: "valid", VerificationState: "verified"},
			want: wantD{allowed: true},
		},
		{
			name: "verification unknown does not block",
			resp: &AuthRetrieveResponse{Status: "outdated", VerificationState: "unknown"},
			want: wantD{allowed: true},
		},
		{name: "disabled", resp: &AuthRetrieveResponse{Status: "disabled"}, want: wantD{reason: "disabled"}},
		{name: "invalid", resp: &AuthRetrieveResponse{Status: "invalid"}, want: wantD{reason: "Invalid API key"}},
		{name: "insecure", resp: &AuthRetrieveResponse{Status: "insecure"}, want: wantD{poll: true, reason: "approval pending"}},
		{name: "insecure-denied", resp: &AuthRetrieveResponse{Status: "insecure-denied"}, want: wantD{reason: "approval denied"}},
		{
			name:  "concurrent valid local",
			resp:  &AuthRetrieveResponse{Status: "concurrent"},
			path:  "/dev/null",
			probe: probeValid,
			want:  wantD{allowed: true, local: true},
		},
		{
			name:  "concurrent invalid local",
			resp:  &AuthRetrieveResponse{Status: "concurrent"},
			path:  "/dev/null",
			probe: probeInvalid,
			want:  wantD{reason: "invalid"},
		},
		{
			name: "concurrent no path",
			resp: &AuthRetrieveResponse{Status: "concurrent"},
			want: wantD{reason: "invalid"},
		},
		{
			name:  "offline fresh 24h",
			resp:  &AuthRetrieveResponse{Status: "offline"},
			path:  "/dev/null",
			probe: probeFresh24Only,
			want:  wantD{allowed: true, local: true, reason: "cached auth.json"},
		},
		{
			name:   "offline stale general host",
			resp:   &AuthRetrieveResponse{Status: "offline"},
			path:   "/dev/null",
			secure: false,
			probe:  probeInvalid,
			want:   wantD{reason: "older than allowed window"},
		},
		{
			name:   "offline secure-host 7d fallback",
			resp:   &AuthRetrieveResponse{Status: "offline"},
			path:   "/dev/null",
			secure: true,
			probe:  probeFresh7Only,
			want:   wantD{allowed: true, local: true, reason: "secure host"},
		},
		{
			name:  "offline no path",
			resp:  &AuthRetrieveResponse{Status: "offline"},
			probe: probeFresh24Only,
			want:  wantD{reason: "no cached auth.json"},
		},
		{
			name: "api_disabled overrides any status",
			resp: &AuthRetrieveResponse{
				Status:   "valid",
				Versions: &VersionSummary{APIDisabled: true},
			},
			want: wantD{reason: "disabled by administrator"},
		},
		{
			name: "installation_id mismatch",
			resp: &AuthRetrieveResponse{
				Status:  "valid",
				Message: "host installation_id 42 does not match server",
			},
			want: wantD{reason: "Installation ID mismatch"},
		},
		{
			name:  "error fresh local",
			resp:  &AuthRetrieveResponse{Status: "error", Message: "runner unreachable"},
			path:  "/dev/null",
			probe: probeFresh24Only,
			want:  wantD{allowed: true, local: true, reason: "cached auth"},
		},
		{
			name:  "error stale local",
			resp:  &AuthRetrieveResponse{Status: "error", Message: "runner unreachable"},
			path:  "/dev/null",
			probe: probeInvalid,
			want:  wantD{reason: "runner unreachable"},
		},
		{
			name: "error no local",
			resp: &AuthRetrieveResponse{Status: "error"},
			want: wantD{reason: "server returned an error"},
		},
		{
			name: "unknown status",
			resp: &AuthRetrieveResponse{Status: "limbo"},
			want: wantD{reason: "Unknown auth status"},
		},
		{
			name: "nil response",
			resp: nil,
			want: wantD{reason: "refusing to start"},
		},
		{
			name:  "empty status with fresh local — treat as offline",
			resp:  &AuthRetrieveResponse{Status: ""},
			path:  "/dev/null",
			probe: probeFresh24Only,
			want:  wantD{allowed: true, local: true},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Decide(tc.resp, tc.path, tc.secure, tc.probe)
			if got.Allowed != tc.want.allowed {
				t.Errorf("Allowed: got=%v want=%v (reason=%q)", got.Allowed, tc.want.allowed, got.Reason)
			}
			if got.NeedsApprovalPoll != tc.want.poll {
				t.Errorf("NeedsApprovalPoll: got=%v want=%v", got.NeedsApprovalPoll, tc.want.poll)
			}
			if got.LocalUsable != tc.want.local {
				t.Errorf("LocalUsable: got=%v want=%v", got.LocalUsable, tc.want.local)
			}
			if tc.want.reason != "" && !strings.Contains(strings.ToLower(got.Reason), strings.ToLower(tc.want.reason)) {
				t.Errorf("Reason: got=%q want substr=%q", got.Reason, tc.want.reason)
			}
		})
	}
}

// TestDecideEngineDisabled pins the launch-gate refusal for an engine disabled
// on the /sync/bootstrap path, where the 403 body (code "engine_disabled") is
// folded into the synthesized offline Message. Without the dedicated branch the
// status would be "offline" and a fresh-cache host would launch a disabled
// engine instead of refusing.
func TestDecideEngineDisabled(t *testing.T) {
	resp := &AuthRetrieveResponse{
		Status:  "offline",
		Message: `POST /sync/bootstrap -> 403: {"status":"error","message":"Engine codex is disabled for this host","code":"engine_disabled"}`,
	}
	got := Decide(resp, "/dev/null", true, LocalAuthProbe{
		IsValid: func(string) bool { return true },
		IsFresh: func(string, time.Duration) (bool, error) { return true, nil },
	})
	if got.Allowed {
		t.Fatalf("engine_disabled must refuse launch, got Allowed=true (reason=%q)", got.Reason)
	}
	if got.Status != "disabled" {
		t.Fatalf("engine_disabled status = %q, want disabled", got.Status)
	}
	if !strings.Contains(strings.ToLower(got.Reason), "disabled") {
		t.Fatalf("reason = %q, want a 'disabled' refusal", got.Reason)
	}
}

// TestDecideIPMismatch pins the static-IP denial from /sync/bootstrap. The
// client exposes that 401 as an offline response, but the API is reachable and
// cached auth must not mask an IP-binding policy violation.
func TestDecideIPMismatch(t *testing.T) {
	resp := &AuthRetrieveResponse{
		Status:  "offline",
		Message: `POST /sync/bootstrap -> 401: {"status":"error","message":"API key not allowed from this IP","code":"ip_mismatch"}`,
	}
	got := Decide(resp, "/dev/null", true, LocalAuthProbe{
		IsValid: func(string) bool { return true },
		IsFresh: func(string, time.Duration) (bool, error) { return true, nil },
	})
	if got.Allowed {
		t.Fatalf("ip_mismatch must refuse launch, got Allowed=true (reason=%q)", got.Reason)
	}
	for _, want := range []string{"ip binding mismatch", "ip_mismatch", "release ip binding"} {
		if !strings.Contains(strings.ToLower(got.Reason), want) {
			t.Fatalf("reason = %q, want %q", got.Reason, want)
		}
	}
}

// TestApplyConcurrent pins the sync-paused secondary-run gate: only downgrades an
// allow to a refusal when local auth is unusable; never upgrades a refusal.
func TestApplyConcurrent(t *testing.T) {
	valid := LocalAuthProbe{IsValid: func(string) bool { return true }}
	invalid := LocalAuthProbe{IsValid: func(string) bool { return false }}

	// allow + usable local → still allowed, marked LocalUsable.
	got := ApplyConcurrent(AuthDecision{Allowed: true, Status: "valid"}, "/dev/null", valid)
	if !got.Allowed || !got.LocalUsable {
		t.Fatalf("allow+valid: got Allowed=%v LocalUsable=%v, want both true", got.Allowed, got.LocalUsable)
	}

	// allow + unusable local → refuse with the spec message.
	got = ApplyConcurrent(AuthDecision{Allowed: true, Status: "valid"}, "/dev/null", invalid)
	if got.Allowed {
		t.Fatalf("allow+invalid local must refuse, got Allowed=true")
	}
	if !strings.Contains(strings.ToLower(got.Reason), "active cdx run") {
		t.Fatalf("reason = %q, want the concurrent refusal message", got.Reason)
	}

	// refusal is never upgraded, regardless of local auth validity.
	got = ApplyConcurrent(AuthDecision{Allowed: false, Reason: "Auth API disabled by administrator."}, "/dev/null", valid)
	if got.Allowed {
		t.Fatalf("concurrent must never upgrade a refusal to allow")
	}
	if got.Reason != "Auth API disabled by administrator." {
		t.Fatalf("hard-stop reason was clobbered: %q", got.Reason)
	}
}
