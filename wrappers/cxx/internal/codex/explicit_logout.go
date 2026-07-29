package codex

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

var errAuthChangedBeforeLogout = errors.New("a newer usable Codex login appeared before logout could be ordered")

type explicitLogoutGuard struct {
	path           string
	before         AuthGeneration
	intent         LogoutIntentGeneration
	previousMarker []byte
}

// RunExplicitLogout implements wrapper-owned logout as a durable transaction.
// It first takes the exclusive session side so a process that already selected
// auth cannot queue immediately before the child. When peers exist, the command
// journals intent under a shared AuthSession and defers native removal to the
// final peer exit. With exclusivity, intent is on disk before native logout is
// started and both maintenance/writer descriptors are inherited by the child.
func RunExplicitLogout(ctx context.Context, cfg *config.Config, args []string, before AuthGeneration) (exit int, marked, deferred bool, retErr error) {
	maintenance, err := TryAcquireAuthMaintenance()
	if errors.Is(err, ipc.ErrHeld) {
		// Distinguish ordinary shared peers from uninstall/another logout. A
		// non-blocking shared acquisition succeeds only in the former case.
		session, sessionErr := StartAuthSession(cfg != nil && !cfg.Host.Secure)
		if sessionErr != nil {
			return 1, false, false, fmt.Errorf("auth maintenance is active: %w", sessionErr)
		}
		marked, markErr := recordDeferredExplicitLogout(before)
		removed, stillDeferred, finishErr := FinishAuthSession(session)
		_ = removed
		if markErr != nil || finishErr != nil {
			return 1, marked, true, errors.Join(markErr, finishErr)
		}
		if !marked {
			return 1, false, stillDeferred, errAuthChangedBeforeLogout
		}
		return 0, true, stillDeferred, nil
	}
	if err != nil {
		return 1, false, false, err
	}
	defer func() {
		retErr = errors.Join(retErr, maintenance.Release())
		if retErr != nil && exit == 0 {
			exit = 1
		}
	}()

	writer, err := tryAcquireAuthWriter()
	if errors.Is(err, ipc.ErrHeld) {
		// A child inherited from a wrapper that died can outlive the shared
		// wrapper session descriptor on older binaries. Preserve intent now;
		// the next managed final-session cleanup will finish native removal.
		marked, markErr := recordDeferredExplicitLogout(before)
		if markErr != nil {
			return 1, marked, true, markErr
		}
		if !marked {
			return 1, false, true, errAuthChangedBeforeLogout
		}
		return 0, true, true, nil
	}
	if err != nil {
		return 1, false, false, err
	}
	defer func() {
		retErr = errors.Join(retErr, writer.Release())
		if retErr != nil && exit == 0 {
			exit = 1
		}
	}()

	guard, err := beginExplicitLogout(before)
	if err != nil {
		return 1, false, false, err
	}
	marked = guard != nil
	if !marked {
		return 1, false, false, errAuthChangedBeforeLogout
	}

	teardown, err := PreExec(ctx, cfg)
	if err != nil {
		kept, finishErr := guard.finish(false)
		return 1, kept, false, errors.Join(err, finishErr)
	}
	defer teardown()
	exit, _, runErr := runCapturePreparedWithHeldLeases(ctx, cfg, args, nil, writer, maintenance)
	marked, finishErr := guard.finish(runErr == nil && exit == 0)
	if runErr != nil {
		return exit, marked, false, errors.Join(runErr, finishErr)
	}
	return exit, marked, false, finishErr
}

func beginExplicitLogout(before AuthGeneration) (*explicitLogoutGuard, error) {
	path, err := AuthPath()
	if err != nil {
		return nil, err
	}
	var guard *explicitLogoutGuard
	err = withAuthLockAt(path, func(string) error {
		current, err := authGenerationAt(path)
		if err != nil {
			return err
		}
		if current != before && authGenerationUsable(path, current) {
			return errAuthChangedBeforeLogout
		}
		previous, err := os.ReadFile(logoutIntentPath(path))
		if errors.Is(err, os.ErrNotExist) {
			previous = nil
		} else if err != nil {
			return err
		}
		intent, err := writeLogoutIntentLocked(path, current)
		if err != nil {
			return err
		}
		guard = &explicitLogoutGuard{
			path:           path,
			before:         current,
			intent:         intent,
			previousMarker: append([]byte(nil), previous...),
		}
		return nil
	})
	return guard, err
}

func recordDeferredExplicitLogout(before AuthGeneration) (bool, error) {
	path, err := AuthPath()
	if err != nil {
		return false, err
	}
	marked := false
	err = withAuthLockAt(path, func(string) error {
		current, err := authGenerationAt(path)
		if err != nil {
			return err
		}
		if current != before && authGenerationUsable(path, current) {
			return nil
		}
		_, err = writeLogoutIntentLocked(path, current)
		marked = err == nil
		return err
	})
	return marked, err
}

func writeLogoutIntentLocked(path string, generation AuthGeneration) (LogoutIntentGeneration, error) {
	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		return LogoutIntentGeneration{}, err
	}
	intent := logoutIntent{
		CreatedAt:  time.Now().UTC().Format(time.RFC3339Nano),
		AuthExists: generation.Exists,
		AuthDigest: generation.Digest,
		Nonce:      hex.EncodeToString(nonceBytes),
	}
	raw, err := json.Marshal(intent)
	if err != nil {
		return LogoutIntentGeneration{}, err
	}
	if err := atomicWriteFile(logoutIntentPath(path), raw, 0o600); err != nil {
		return LogoutIntentGeneration{}, err
	}
	return logoutIntentGenerationAt(path)
}

func (g *explicitLogoutGuard) finish(success bool) (marked bool, err error) {
	if g == nil {
		return false, nil
	}
	err = withAuthLockAt(g.path, func(string) error {
		currentIntent, err := logoutIntentGenerationAt(g.path)
		if err != nil {
			return err
		}
		// Another transaction replaced the journal. Never roll back or remove
		// state governed by a marker that is not ours.
		if currentIntent != g.intent {
			marked = currentIntent.Exists
			return nil
		}
		current, err := authGenerationAt(g.path)
		if err != nil {
			return err
		}
		if current != g.before && authGenerationUsable(g.path, current) {
			// A distinct usable login completed after our pre-child journal.
			// Preserve both it and the marker until the server accepts that exact
			// login; local presence alone is not authority to cancel logout.
			marked = true
			return nil
		}
		if !success && current == g.before && authGenerationUsable(g.path, current) {
			// Upstream failed without changing auth. Restore the exact prior
			// marker state so a failed logout does not invent new intent or erase
			// an older one.
			marked = len(g.previousMarker) > 0
			if len(g.previousMarker) > 0 {
				return atomicWriteFile(logoutIntentPath(g.path), g.previousMarker, 0o600)
			}
			return removeLogoutIntentLocked(g.path)
		}
		// Success always leaves durable intent. A non-zero child that removed
		// or invalidated auth also leaves it, preventing partial-success
		// resurrection on the next bootstrap.
		marked = true
		if success && current.Exists {
			if err := os.Remove(g.path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			return syncDirectory(filepath.Dir(g.path))
		}
		return nil
	})
	return marked, err
}

// completeDeferredLogoutLocked runs with the auth lock, the final exclusive
// session lease, and the active-child writer held. It keeps the marker after
// removal so canonical retrieve cannot undo explicit user intent. A distinct
// usable generation is preserved as an upload candidate; only server acceptance
// of that exact auth+marker snapshot cancels the marker.
func completeDeferredLogoutLocked(path string) (bool, error) {
	raw, err := os.ReadFile(logoutIntentPath(path))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var marker logoutIntent
	if err := json.Unmarshal(raw, &marker); err != nil {
		return false, fmt.Errorf("parse Codex logout intent: %w", err)
	}
	current, err := authGenerationAt(path)
	if err != nil {
		return false, err
	}
	if !current.Exists {
		return false, nil
	}
	if authGenerationUsable(path, current) && (!marker.AuthExists || current.Digest != marker.AuthDigest) {
		// A newer local login is a candidate, not yet an acknowledgement.
		// Leave both generations intact for the bounded upload transaction.
		return false, nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := syncDirectory(filepath.Dir(path)); err != nil {
		return false, err
	}
	return true, nil
}

func authGenerationUsable(path string, generation AuthGeneration) bool {
	if !generation.Exists {
		return false
	}
	return IsValidLocalAuth(path)
}

func removeLogoutIntentLocked(path string) error {
	if err := os.Remove(logoutIntentPath(path)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}
