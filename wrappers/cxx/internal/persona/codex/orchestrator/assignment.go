package orchestrator

import (
	"context"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
)

// AuthAfterAssignment retains this launch's verified auth/usage snapshot when
// the newly acquired lease confirms the very same account and canonical head.
// A switch, rotation, incomplete snapshot or older server still gets a fresh
// account-scoped retrieve. No snapshot is shared between launches.
func (c *Client) AuthAfterAssignment(ctx context.Context, previous *AuthRetrieveResponse, lease *accountpool.LeaseResponse) (*AuthRetrieveResponse, error) {
	if previous == nil || previous.Status != "valid" || !previous.AccountPool ||
		previous.Host == nil || previous.Versions == nil || previous.CandidateRejectedDefinitive || previous.CandidateCredentialRejected ||
		previous.VerificationState != "verified" || lease.VerificationState != "verified" ||
		previous.AccountID <= 0 || previous.AccountID != lease.AccountID ||
		previous.CanonicalDigest == "" || previous.CanonicalDigest != lease.CanonicalDigest {
		return c.AuthRetrieve(ctx, lease.CanonicalDigest)
	}
	// The lease reads quota policy again at admission. Keep its newer controls
	// while using the account's usage snapshot already fetched by this launch.
	out := *previous
	if lease.QuotaHardFail != nil {
		out.QuotaHardFail = *lease.QuotaHardFail
	}
	if lease.QuotaLimitPercent != nil {
		out.QuotaLimitPercent = lease.QuotaLimitPercent
	}
	if lease.QuotaWeekPartition != nil {
		out.QuotaWeekPartition = lease.QuotaWeekPartition
	}
	return &out, nil
}
