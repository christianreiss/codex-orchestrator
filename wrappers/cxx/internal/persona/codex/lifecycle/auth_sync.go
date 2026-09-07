package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// SessionAuthSyncResult identifies only the generation actually submitted or
// adopted, never a newer native write observed after the request completed.
type SessionAuthSyncResult struct {
	Generation codex.AuthGeneration
	Uploaded   bool
	Adopted    bool
	Deferred   bool
}

// SyncSessionAuth converges existing, usable auth without starting a native CLI
// or restoring credentials after logout/purge. Unacknowledged native bytes are
// offered before any pull; a transient rejection leaves that candidate intact.
func SyncSessionAuth(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) (SessionAuthSyncResult, error) {
	if logger == nil {
		logger = slog.Default()
	}
	path, err := codex.AuthPath()
	if err != nil {
		return SessionAuthSyncResult{}, err
	}
	expected, err := codex.CurrentAuthGeneration()
	if err != nil {
		return SessionAuthSyncResult{}, err
	}
	result := SessionAuthSyncResult{Generation: expected}
	if !expected.Exists || !codex.IsValidLocalAuth(path) {
		result.Deferred = true
		return result, nil
	}
	known, err := codex.IsCanonicalAuthGeneration(expected)
	if err != nil {
		return result, err
	}
	if !known {
		return uploadSessionAuth(ctx, client, logger, path)
	}
	if active, err := codex.LogoutIntentActiveContext(ctx); err != nil || active {
		result.Deferred = true
		return result, err
	}
	resp, err := client.AuthRetrieve(ctx, expected.Digest)
	if err != nil {
		return result, err
	}
	if resp != nil && resp.Engine != "" && !strings.EqualFold(strings.TrimSpace(resp.Engine), "codex") {
		return result, errors.New("session auth response belongs to another engine")
	}
	if err := updateAuthSessionSecurityContext(ctx, resp); err != nil {
		return result, err
	}
	if resp != nil {
		switch strings.ToLower(strings.TrimSpace(resp.Status)) {
		case "upload_required", "missing":
			return uploadSessionAuth(ctx, client, logger, path)
		}
	}
	return applySessionAuthResponse(ctx, path, resp, result)
}

func uploadSessionAuth(ctx context.Context, client *orchestrator.Client, logger *slog.Logger, path string) (SessionAuthSyncResult, error) {
	resp, expected, err := storeAutomaticAuthCandidate(ctx, client)
	result := SessionAuthSyncResult{Generation: expected, Uploaded: err == nil && resp.AuthCandidateAccepted()}
	if errors.Is(err, codex.ErrLogoutIntentActive) || errors.Is(err, os.ErrNotExist) {
		result.Deferred = true
		return result, nil
	}
	// A verified newer canonical can win arbitration even when the submitted
	// candidate was not accepted. Transport/policy failures provide no such
	// authority; keep the local generation and retry it later.
	if err != nil && (resp == nil || !shouldWriteServerAuth(resp.Status, resp.Auth) ||
		!strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified")) {
		return result, err
	}
	applied, applyErr := applySessionAuthResponse(ctx, path, resp, result)
	if applyErr != nil {
		return applied, errors.Join(err, applyErr)
	}
	if applied.Adopted {
		logger.Debug("session canonical auth adopted")
		return applied, updateAuthSessionSecurityContext(ctx, resp)
	}
	if err != nil {
		return applied, err
	}
	if result.Uploaded {
		// An identical accepted credential may retain a newer local timestamp
		// than the canonical envelope. Bind its exact accepted bytes even when
		// freshness correctly deferred the older server write-back.
		acknowledged, ackErr := codex.AcknowledgeCanonicalAuthGeneration(ctx, expected)
		if ackErr != nil {
			return applied, ackErr
		}
		applied.Deferred = applied.Deferred || !acknowledged
		if acknowledged {
			return applied, updateAuthSessionSecurityContext(ctx, resp)
		}
	}
	return applied, nil
}

// UploadAutomaticAuth offers only an existing unbound native generation. It
// never retrieves credentials or treats a late native write as manual login.
func UploadAutomaticAuth(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) (SessionAuthSyncResult, error) {
	path, err := codex.AuthPath()
	if err != nil {
		return SessionAuthSyncResult{}, err
	}
	expected, err := codex.CurrentAuthGeneration()
	if err != nil {
		return SessionAuthSyncResult{}, err
	}
	result := SessionAuthSyncResult{Generation: expected}
	if !expected.Exists || !codex.IsValidLocalAuth(path) {
		result.Deferred = true
		return result, nil
	}
	known, err := codex.IsCanonicalAuthGeneration(expected)
	if err != nil || known {
		return result, err
	}
	resp, submitted, storeErr := storeAutomaticAuthCandidate(ctx, client)
	result.Generation = submitted
	if errors.Is(storeErr, codex.ErrLogoutIntentActive) || errors.Is(storeErr, os.ErrNotExist) {
		result.Deferred = true
		return result, nil
	}
	if resp == nil || !strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified") {
		return result, errors.Join(storeErr, errors.New("automatic upload is not verified"))
	}
	if !resp.AuthCandidateAccepted() {
		// A verified canonical winner can classify this idle candidate as
		// obsolete. It does not authorize writing credentials or opening a new
		// purge obligation; the next native session owns canonical adoption.
		stamp, stampErr := codex.LastRefreshFromRaw(resp.Auth)
		if !shouldWriteServerAuth(resp.Status, resp.Auth) || !codex.IsValidAuthPayload(resp.Auth) || stampErr != nil ||
			stamp.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) || stamp.After(time.Now().Add(5*time.Minute)) ||
			(localAuthFresherThan(path, resp.Auth) && !resp.CandidateRejectedDefinitive) {
			return result, errors.Join(storeErr, errors.New("automatic upload did not converge"))
		}
		current, err := codex.CurrentAuthGeneration()
		if err != nil {
			return result, err
		}
		if current != submitted {
			return result, errors.New("native credentials changed during automatic upload")
		}
		result.Deferred = true
		return result, nil
	}
	if storeErr != nil {
		return result, storeErr
	}
	if len(resp.Auth) > 0 {
		local, err := codex.ReadAuth()
		if err != nil {
			return result, err
		}
		if !codex.SameAuthCredentials(local, resp.Auth) {
			return result, errors.New("accepted response selected different canonical credentials; active session sync is required")
		}
	}
	acknowledged, err := codex.AcknowledgeCanonicalAuthGeneration(ctx, submitted)
	if err != nil {
		return result, err
	}
	if !acknowledged {
		return result, errors.New("native credentials changed during automatic upload acknowledgement")
	}
	result.Uploaded = true
	return result, updateAuthSessionSecurityContext(ctx, resp)
}

// Native Codex 0.153.4 caches healthy auth, then reloads same-account disk
// credentials during 401 recovery and before refreshing. A disk adoption is
// useful at those boundaries; it is not an immediate in-memory reload signal.
// Keep this path quieter and stricter than pre-launch recovery: no stderr,
// account recovery, or CAS retry over a native deletion/partial write.
func applySessionAuthResponse(ctx context.Context, path string, resp *orchestrator.AuthRetrieveResponse, result SessionAuthSyncResult) (SessionAuthSyncResult, error) {
	if resp != nil && resp.Engine != "" && !strings.EqualFold(strings.TrimSpace(resp.Engine), "codex") {
		return result, errors.New("session auth response belongs to another engine")
	}
	if resp == nil || !strings.EqualFold(strings.TrimSpace(resp.VerificationState), "verified") {
		return result, errors.New("session canonical auth is not verified")
	}
	if !shouldWriteServerAuth(resp.Status, resp.Auth) {
		switch strings.ToLower(strings.TrimSpace(resp.Status)) {
		case "valid", "updated", "current", "ok", "unchanged":
			return result, nil
		default:
			return result, fmt.Errorf("session auth unavailable (status %q)", resp.Status)
		}
	}
	stamp, err := codex.LastRefreshFromRaw(resp.Auth)
	if err != nil || stamp.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) || stamp.After(time.Now().Add(5*time.Minute)) {
		return result, errors.New("session canonical auth has invalid freshness")
	}
	if localAuthFresherThan(path, resp.Auth) && !resp.CandidateRejectedDefinitive {
		result.Deferred = true
		return result, nil
	}
	sum := sha256.Sum256(resp.Auth)
	canonical := codex.AuthGeneration{Exists: true, Digest: hex.EncodeToString(sum[:])}
	if canonical == result.Generation {
		return result, nil
	}
	// One exact CAS only: ConvergeAuthIfCurrent intentionally allows pre-launch
	// recovery across unusable generations, which could resurrect a native
	// logout here. Any intervening bytes or disappearance must win instead.
	wrote, err := codex.WriteSessionAuthIfCurrent(ctx, resp.Auth, result.Generation)
	if err != nil {
		return result, err
	}
	if wrote.Written {
		result.Generation = canonical
		result.Adopted = true
	} else {
		result.Deferred = true
	}
	return result, nil
}
