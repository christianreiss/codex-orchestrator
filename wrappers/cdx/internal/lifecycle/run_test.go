package lifecycle

import (
	"errors"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
)

func TestNeedsInteractiveAuthRecovery(t *testing.T) {
	cases := []struct {
		name      string
		decision  orchestrator.AuthDecision
		uploadErr error
		want      bool
	}{
		{
			name: "live verification failure",
			decision: orchestrator.AuthDecision{
				Status: "outdated",
				Reason: "Codex credentials failed live verification (login expired).",
			},
			want: true,
		},
		{
			name: "missing with upload failure",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "missing",
			},
			uploadErr: errors.New("runner rejected token"),
			want:      true,
		},
		{
			name: "normal valid auth",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "valid",
			},
			want: false,
		},
		{
			name: "disabled host is not a login recovery",
			decision: orchestrator.AuthDecision{
				Status: "disabled",
				Reason: "Auth API disabled by administrator.",
			},
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := needsInteractiveAuthRecovery(tc.decision, tc.uploadErr); got != tc.want {
				t.Fatalf("needsInteractiveAuthRecovery() = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestDecideAuthRecovery pins the launch-gate rule that headless callers
// (cron, --execute) fail closed instead of opening an interactive `codex login`
// prompt — the spec's "Non-interactive runs fail closed" guarantee, which the
// gate previously only enforced via term.IsTerminal (so --execute on a TTY
// would still prompt).
func TestDecideAuthRecovery(t *testing.T) {
	cases := []struct {
		name                            string
		concurrent, headless, recovered bool
		want                            authRecoveryAction
	}{
		{"interactive run recovers", false, false, true, authRecoveryInteractive},
		{"headless --execute fails closed", false, true, true, authRecoveryFailClosed},
		{"concurrent never recovers", true, false, true, authRecoverySkip},
		{"concurrent+headless never recovers", true, true, true, authRecoverySkip},
		{"nothing needed", false, false, false, authRecoverySkip},
		{"headless but nothing needed", false, true, false, authRecoverySkip},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := decideAuthRecovery(tc.concurrent, tc.headless, tc.recovered); got != tc.want {
				t.Fatalf("decideAuthRecovery(%v,%v,%v) = %v, want %v",
					tc.concurrent, tc.headless, tc.recovered, got, tc.want)
			}
		})
	}
}
