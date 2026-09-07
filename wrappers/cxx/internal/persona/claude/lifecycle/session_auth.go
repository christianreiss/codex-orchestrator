package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/authnotice"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

// SessionAuthSyncResult contains metadata only. Generation identifies the
// exact submitted or adopted bytes, never a later native login observed after
// a request. Deferred means native credentials/logout won a concurrent race.
type SessionAuthSyncResult struct {
	Generation claude.AuthGeneration
	Uploaded   bool
	Adopted    bool
	Deferred   bool
	HostSecure *bool
}

// SyncSessionAuth exchanges existing usable credentials without login, refresh,
// launch, config sync, or purge. Unacknowledged native credentials are offered
// for arbitration before any remote generation can replace them. The caller
// supplies a deadline and decides whether an active session permits polling.
func SyncSessionAuth(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) (SessionAuthSyncResult, error) {
	if logger == nil {
		logger = slog.Default()
	}
	snap, err := claude.ReadAuthForRetrieveSnapshotContext(ctx)
	if errors.Is(err, os.ErrNotExist) {
		return SessionAuthSyncResult{Deferred: true}, nil
	}
	if err != nil {
		return SessionAuthSyncResult{}, err
	}
	result := SessionAuthSyncResult{Generation: snap.Generation}
	if !snap.Usable {
		result.Deferred = true
		return result, nil
	}
	var resp *orchestrator.AuthRetrieveResponse
	attemptedUpload := false
	if snap.ServerDigest == "" {
		attemptedUpload = true
		resp, snap, err = storeChangedAuthCandidate(ctx, client)
		result.Generation = snap.Generation
		result.Uploaded = err == nil && resp.AuthCandidateAccepted()
	} else {
		// Digest only: a local timestamp can turn a newer canonical into an
		// upload_required response instead of returning its actual credentials.
		resp, err = client.AuthRetrieve(ctx, snap.DigestForServer())
		if err == nil && resp != nil && (strings.EqualFold(strings.TrimSpace(resp.Status), "upload_required") || strings.EqualFold(strings.TrimSpace(resp.Status), "missing")) {
			attemptedUpload = true
			resp, snap, err = storeChangedAuthCandidate(ctx, client)
			result.Generation = snap.Generation
			result.Uploaded = err == nil && resp.AuthCandidateAccepted()
		}
	}
	if errors.Is(err, claude.ErrAuthUploadBlockedByLogout) {
		result.Deferred = true
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if resp != nil && resp.Engine != "" && !strings.EqualFold(strings.TrimSpace(resp.Engine), "claude") {
		return result, errors.New("session auth response belongs to another engine")
	}
	if secure, known := resp.HostSecurity(); known {
		result.HostSecure = &secure
	}
	if resp == nil || !strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified") {
		return result, errors.New("session auth response is not verified; local credentials retained")
	}
	if len(resp.Auth) > 0 && claude.ServerAuthMayReplace(snap, resp.Auth, resp.CanonicalLastRefresh, resp.VerificationState, resp.CandidateRejectedDefinitive) {
		generation, applied, err := claude.WriteSessionAuthIfCurrentWithDigest(ctx, resp.Auth, resp.CanonicalDigest, resp.VerificationState, snap.Generation)
		if err != nil {
			return result, fmt.Errorf("apply session auth: %w", err)
		}
		if !applied {
			result.Deferred = true
			return result, nil
		}
		result.Generation = generation
		result.Adopted = generation != snap.Generation
		if result.Adopted {
			if err := authnotice.Publish("claude", generation.Digest); err != nil {
				logger.Warn("Claude auth change notice unavailable", "err", err)
			}
			logger.Debug("verified Claude credentials adopted during session")
		}
		return result, nil
	}
	if result.Uploaded {
		digest := resp.CanonicalDigest
		if digest == "" {
			digest = resp.Digest
		}
		acknowledged, err := claude.AcknowledgeAuthGeneration(ctx, snap.Generation, digest)
		result.Deferred = !acknowledged
		return result, err
	}
	if attemptedUpload || strings.EqualFold(strings.TrimSpace(resp.Status), "outdated") {
		return result, errors.New("session auth arbitration did not converge; local credentials retained")
	}
	return result, nil
}
