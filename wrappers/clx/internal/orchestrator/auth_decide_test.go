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
		reason  string
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
			name:  "offline fresh",
			resp:  &AuthRetrieveResponse{Status: "offline"},
			path:  "/dev/null",
			probe: probeFresh24Only,
			want:  wantD{allowed: true, local: true, reason: "cached credentials"},
		},
		{
			name:   "offline stale insecure",
			resp:   &AuthRetrieveResponse{Status: "offline"},
			path:   "/dev/null",
			secure: false,
			probe:  probeInvalid,
			want:   wantD{reason: "older than allowed window"},
		},
		{
			name:   "offline secure-host 7d",
			resp:   &AuthRetrieveResponse{Status: "offline"},
			path:   "/dev/null",
			secure: true,
			probe:  probeFresh7Only,
			want:   wantD{allowed: true, local: true, reason: "secure host"},
		},
		{
			name: "api_disabled overrides",
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
			want:  wantD{allowed: true, local: true, reason: "cached credentials"},
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
			name: "unknown",
			resp: &AuthRetrieveResponse{Status: "limbo"},
			want: wantD{reason: "Unknown auth status"},
		},
		{
			name: "nil response",
			resp: nil,
			want: wantD{reason: "refusing"},
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
