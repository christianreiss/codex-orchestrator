package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// UploadPendingAuthBeforeUpdate saves existing native credentials before
// maintenance. It never retrieves or materializes auth, and never creates a
// purge obligation: a failed download must leave an unsaved login recoverable.
func UploadPendingAuthBeforeUpdate(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			timer := time.NewTimer(time.Duration(attempt) * 200 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return errors.Join(lastErr, ctx.Err())
			case <-timer.C:
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
		logger.Debug("pending Codex auth update guard retry", "attempt", attempt+1, "err", lastErr)
	}
	return fmt.Errorf("pending Codex credentials could not be confirmed by the orchestrator; update stopped and existing credentials retained: %w", lastErr)
}

func uploadPendingAuthBeforeUpdateAttempt(ctx context.Context, client *orchestrator.Client) error {
	path, err := codex.AuthPath()
	if err != nil {
		return err
	}
	expected, err := codex.CurrentAuthGeneration()
	if err != nil {
		return err
	}
	if !expected.Exists || !codex.IsValidLocalAuth(path) {
		return nil
	}
	known, err := codex.IsCanonicalAuthGeneration(expected)
	if err != nil || known {
		return err
	}
	resp, submitted, storeErr := storeAutomaticAuthCandidate(ctx, client)
	if errors.Is(storeErr, codex.ErrLogoutIntentActive) || errors.Is(storeErr, os.ErrNotExist) {
		return nil
	}
	if resp == nil || !strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified") ||
		(resp.Engine != "" && !strings.EqualFold(strings.TrimSpace(resp.Engine), "codex")) {
		return errors.Join(storeErr, errors.New("candidate arbitration is not verified for Codex"))
	}
	if !resp.AuthCandidateAccepted() {
		stamp, stampErr := codex.LastRefreshFromRaw(resp.Auth)
		if !shouldWriteServerAuth(resp.Status, resp.Auth) || !codex.IsValidAuthPayload(resp.Auth) || stampErr != nil ||
			stamp.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) || stamp.After(time.Now().Add(5*time.Minute)) ||
			(localAuthFresherThan(path, resp.Auth) && !resp.CandidateRejectedDefinitive) {
			return errors.Join(storeErr, errors.New("candidate arbitration did not converge"))
		}
	}
	current, err := codex.CurrentAuthGeneration()
	if err != nil {
		return err
	}
	if current != submitted {
		return errors.New("native credentials changed during update arbitration")
	}
	if resp.AuthCandidateAccepted() {
		if storeErr != nil {
			return storeErr
		}
		acknowledged, err := codex.AcknowledgeCanonicalAuthGeneration(ctx, submitted)
		if err != nil {
			return err
		}
		if !acknowledged {
			return errors.New("accepted native credential generation could not be acknowledged")
		}
	}
	return nil
}
