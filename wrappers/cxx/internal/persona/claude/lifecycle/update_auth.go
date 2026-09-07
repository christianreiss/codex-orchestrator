package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

// UploadPendingAuthBeforeUpdate protects an existing native login/rotation
// before maintenance can replace the wrapper or finalize its auth lease. It
// never downloads credentials: an unsuccessful update must leave the existing
// file and logout intent alone, without creating a new purge obligation.
func UploadPendingAuthBeforeUpdate(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			if err := waitAuthRetry(ctx, time.Duration(attempt)*200*time.Millisecond); err != nil {
				return errors.Join(lastErr, err)
			}
		}
		attemptCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		lastErr = uploadPendingAuthBeforeUpdateAttempt(attemptCtx, client)
		cancel()
		if lastErr == nil {
			return nil
		}
		if ctx.Err() != nil {
			break
		}
		logger.Debug("pending Claude auth update guard retry", "attempt", attempt+1, "err", lastErr)
	}
	return fmt.Errorf("pending Claude credentials could not be confirmed by the orchestrator; update stopped and existing credentials retained: %w", lastErr)
}

func uploadPendingAuthBeforeUpdateAttempt(ctx context.Context, client *orchestrator.Client) error {
	snap, err := claude.ReadAuthForRetrieveSnapshotContext(ctx)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !snap.Usable || snap.ServerDigest != "" {
		return nil
	}
	resp, snap, err := storeChangedAuthCandidate(ctx, client)
	if errors.Is(err, claude.ErrAuthUploadBlockedByLogout) {
		return nil
	}
	if err != nil {
		return err
	}
	if resp == nil || !strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified") ||
		(resp.Engine != "" && !strings.EqualFold(strings.TrimSpace(resp.Engine), "claude")) {
		return errors.New("candidate arbitration is not verified for Claude")
	}
	if !resp.AuthCandidateAccepted() && (len(resp.Auth) == 0 || !claude.ServerAuthMayReplace(snap, resp.Auth, resp.CanonicalLastRefresh, resp.VerificationState, resp.CandidateRejectedDefinitive)) {
		return errors.New("candidate arbitration did not converge")
	}
	latest, err := claude.ReadAuthSnapshotContext(ctx, false)
	if err != nil {
		return err
	}
	if latest.Generation != snap.Generation {
		return errors.New("native credentials changed during update arbitration")
	}
	if resp.AuthCandidateAccepted() {
		digest := resp.CanonicalDigest
		if digest == "" {
			digest = resp.Digest
		}
		acknowledged, err := claude.AcknowledgeAuthGeneration(ctx, snap.Generation, digest)
		if err != nil {
			return err
		}
		if !acknowledged {
			return errors.New("accepted native credential generation could not be acknowledged")
		}
	}
	return nil
}

func waitAuthRetry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
