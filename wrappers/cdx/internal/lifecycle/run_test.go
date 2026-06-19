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
