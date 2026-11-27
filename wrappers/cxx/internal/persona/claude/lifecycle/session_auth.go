package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"log/slog"
	"os"
	"strings"
	"time"

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
	// ServerKnown: the local generation had been confirmed by the server
	// before and was not offered again. Rejected: the server refused it for
	// good. Either way nothing of it is left to upload.
	ServerKnown bool
	Rejected    bool
}

// ErrSessionAuthUnverified: the server answered, but the account's head is
// not verified, so no credentials were exchanged.
var ErrSessionAuthUnverified = errors.New("session auth response is not verified; local credentials retained")

// BoundAccountMismatch reports that the local credentials are a login the
// server holds for another account than the one this scope is bound to: a
// live switch was committed and its write never happened here. It carries
// the bound account's verified head. Refresh times of two accounts say
// nothing about each other, so that head is authoritative; it is written by
// whoever holds the turn gate, never by a background sync next to a running
// session.
type BoundAccountMismatch struct {
	BoundAccountID     int64
	PresentedAccountID int64
	Auth               json.RawMessage
	CanonicalDigest    string
	VerificationState  string
	// Generation is the local file the server recognised.
	Generation claude.AuthGeneration
}

func (e *BoundAccountMismatch) Error() string {
	return fmt.Sprintf("local Claude credentials are account #%d while this scope is bound to #%d; the bound account's credentials follow at the next turn boundary", e.PresentedAccountID, e.BoundAccountID)
}

// boundBefore is the scope's binding when the request was sent. Without one
// the answer is for the server's default account, which claims nothing about
// this scope (the pool adopts the answered account only afterwards).
func boundAccountMismatch(boundBefore int64, resp *orchestrator.AuthRetrieveResponse, snap claude.AuthSnapshot) *BoundAccountMismatch {
	if boundBefore <= 0 {
		return nil
	}
	if !resp.PresentedOtherAccount() || len(resp.Auth) == 0 {
		return nil
	}
	return &BoundAccountMismatch{
		BoundAccountID: resp.AccountID, PresentedAccountID: resp.PresentedAccountID,
		Auth: resp.Auth, CanonicalDigest: resp.CanonicalDigest, VerificationState: resp.VerificationState,
		Generation: snap.Generation,
	}
}

// scopeInUse reports a native session that may be mid-turn on the local
// credentials. Unknown counts as in use.
var scopeInUse = func(client *orchestrator.Client) bool {
	if len(client.Pool.LiveSessions()) > 0 {
		return true
	}
	active, err := claude.HasActiveAuthChild()
	return err != nil || active
}

// SyncSessionAuth exchanges existing usable credentials without login, refresh,
// launch, config sync, or purge. Unacknowledged native credentials are offered
// for arbitration before any remote generation can replace them. The caller
// supplies a deadline and decides whether an active session permits polling.
func SyncSessionAuth(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) (SessionAuthSyncResult, error) {
	fencePath, _ := claude.AuthPath()
	release, fenceErr := communicator.Fence(ctx, client.BaseURL, "claude", fencePath)
	if fenceErr != nil {
		return SessionAuthSyncResult{}, fenceErr
	}
	defer release()
	if communicator.PendingAuth(client.BaseURL, "claude", fencePath) {
		return SessionAuthSyncResult{Deferred: true}, errors.New("previous auth upload outcome unresolved; refusing to replay after handoff; inspect with clx auth-reconcile")
	}

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
	boundBefore, _ := client.Pool.Binding()
	if !snap.Usable {
		if claude.IsDeadTokenClear(snap.Raw) {
			return healDeadTokenClear(ctx, client, logger, snap, boundBefore, result)
		}
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
	result.ServerKnown = snap.ServerDigest != "" && !attemptedUpload
	result.Rejected = resp != nil && resp.CandidateRejectedDefinitive
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
		return result, ErrSessionAuthUnverified
	}
	if mismatch := boundAccountMismatch(boundBefore, resp, snap); mismatch != nil {
		if scopeInUse(client) {
			client.Pool.MarkRepair()
			return result, mismatch
		}
		// Nothing runs on these credentials: the bound account's head replaces
		// them here, fenced on the exact file the server recognised.
		generation, applied, err := claude.WriteSessionAuthIfCurrentWithDigest(ctx, resp.Auth, resp.CanonicalDigest, resp.VerificationState, snap.Generation)
		if err != nil {
			return result, fmt.Errorf("apply bound account credentials: %w", err)
		}
		if !applied {
			result.Deferred = true
			return result, nil
		}
		client.Pool.ClearRepair()
		result.Generation, result.Adopted = generation, true
		if err := authnotice.Publish("claude", generation.Digest); err != nil {
			logger.Warn("Claude auth change notice unavailable", "err", err)
		}
		logger.Info("Claude credentials replaced by the bound account's", "from", mismatch.PresentedAccountID, "to", mismatch.BoundAccountID)
		return result, nil
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

// ErrDeadTokenAwaitingCanonical: the local credentials are Claude Code's
// dead-token clear and the server has no verified canonical yet that may
// replace them. It is an error, not a defer, so the scheduler keeps retrying
// with backoff until the generation that won the refresh race arrives.
var ErrDeadTokenAwaitingCanonical = errors.New("local Claude credentials were cleared after a failed refresh; waiting for a newer verified canonical")

// healDeadTokenClear replaces Claude Code's dead-token clear with the bound
// account's verified canonical. That record is what a host writes after it
// lost a refresh race to another host holding the same login: its refresh
// token was already spent. Nothing local is left to upload or arbitrate, so
// this is a retrieve-only exchange (a digest-less store would offer the blank
// record), fenced on the exact dead generation. The native writer still
// refuses over an explicit logout intent.
func healDeadTokenClear(ctx context.Context, client *orchestrator.Client, logger *slog.Logger, snap claude.AuthSnapshot, boundBefore int64, result SessionAuthSyncResult) (SessionAuthSyncResult, error) {
	resp, err := client.AuthRetrieve(ctx, "")
	if err != nil {
		return result, err
	}
	if resp == nil {
		return result, ErrDeadTokenAwaitingCanonical
	}
	if resp.Engine != "" && !strings.EqualFold(strings.TrimSpace(resp.Engine), "claude") {
		return result, errors.New("session auth response belongs to another engine")
	}
	if secure, known := resp.HostSecurity(); known {
		result.HostSecure = &secure
	}
	if !strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified") {
		return result, ErrSessionAuthUnverified
	}
	// A switch committed between the binding read and the answer belongs to
	// the turn gate; the next pass reads the new binding.
	if boundBefore > 0 && resp.AccountID > 0 && resp.AccountID != boundBefore {
		return result, ErrDeadTokenAwaitingCanonical
	}
	if len(resp.Auth) == 0 || !claude.DeadTokenHealCandidate(snap.Raw, resp.Auth, time.Now()) {
		return result, ErrDeadTokenAwaitingCanonical
	}
	generation, applied, err := claude.WriteSessionAuthIfCurrentWithDigest(ctx, resp.Auth, resp.CanonicalDigest, resp.VerificationState, snap.Generation)
	if err != nil {
		return result, fmt.Errorf("replace cleared Claude credentials: %w", err)
	}
	if !applied {
		// The file changed under us (a native login, logout or another
		// writer); its own change notification starts the next pass.
		result.Deferred = true
		return result, nil
	}
	result.Generation, result.Adopted = generation, true
	if err := authnotice.Publish("claude", generation.Digest); err != nil {
		logger.Warn("Claude auth change notice unavailable", "err", err)
	}
	logger.Info("Claude credentials cleared after a lost refresh replaced by the verified canonical", "account", resp.AccountID)
	return result, nil
}
