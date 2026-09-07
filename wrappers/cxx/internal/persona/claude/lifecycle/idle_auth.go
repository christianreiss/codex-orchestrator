package lifecycle

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

type IdleAuthUploadResult struct {
	Uploaded   bool
	HostSecure *bool
}

// UploadIdleAuth publishes only existing local account credentials. It refuses
// any logout under the same lock held through store, never adopts a canonical
// response, and never acknowledges a logout on behalf of an unattended worker.
func UploadIdleAuth(ctx context.Context, client *orchestrator.Client) (IdleAuthUploadResult, error) {
	result := IdleAuthUploadResult{}
	snap, _, release, err := claude.BeginIdleAuthUploadStateContext(ctx)
	if errors.Is(err, claude.ErrAuthUploadBlockedByLogout) || errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	defer release()
	if !snap.Usable || snap.ServerDigest != "" {
		return result, nil
	}
	resp, err := client.AuthStore(ctx, snap.Upload)
	release()
	if err != nil {
		return result, err
	}
	if resp != nil && resp.Engine != "" && !strings.EqualFold(strings.TrimSpace(resp.Engine), "claude") {
		return result, errors.New("automatic auth response belongs to another engine")
	}
	if !resp.AuthCandidateAccepted() {
		return result, errors.New("automatic Claude upload was not accepted; native credentials retained")
	}
	if len(resp.Auth) > 0 && !claude.SameCredentialPair(snap.Raw, resp.Auth) {
		return result, errors.New("automatic upload returned different canonical credentials; local generation retained for active synchronization")
	}
	digest := resp.CanonicalDigest
	if digest == "" {
		digest = resp.Digest
	}
	acknowledged, err := claude.AcknowledgeAuthGeneration(ctx, snap.Generation, digest)
	if err != nil {
		return result, err
	}
	if !acknowledged {
		return result, errors.New("native credentials or logout changed during automatic upload; newer local state retained")
	}
	result.Uploaded = true
	if secure, known := resp.HostSecurity(); known {
		result.HostSecure = &secure
	}
	return result, nil
}
