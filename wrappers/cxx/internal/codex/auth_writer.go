package codex

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

// AuthGeneration identifies one exact on-disk auth.json generation. It is
// deliberately content-based: atomic renames change inode/mtime even when the
// credential did not change, while the digest remains stable.
type AuthGeneration struct {
	Exists bool
	Digest string
}

// LogoutIntentGeneration identifies the exact marker observed when an upload
// starts. It lets a successful store clear an older marker without erasing a
// logout created while that request was in flight.
type LogoutIntentGeneration struct {
	Exists bool
	Digest string
}

// AuthWriteResult distinguishes a compare-and-swap miss from a write that was
// blocked solely because an unchanged native Codex generation is still in
// use. Callers may preserve the former, but must fail closed on the latter
// when the server says canonical materialization is required.
type AuthWriteResult struct {
	Written              bool
	BlockedByActiveChild bool
}

// AuthConvergenceResult describes a monotonic canonical response application.
// KeptNewerGeneration is true only when a changed, usable on-disk generation
// is either a native/local write or a canonical generation at least as fresh
// as the response. Current records the last generation compared so callers can
// distinguish that case from an unchanged blocked file.
type AuthConvergenceResult struct {
	Written              bool
	AlreadyCurrent       bool
	KeptNewerGeneration  bool
	BlockedByActiveChild bool
	Current              AuthGeneration
}

const canonicalGenerationLedgerFile = ".cdx-canonical-auth-generations.json"

type canonicalGenerationLedger struct {
	Digests          []string `json:"digests"`
	LastRefresh      string   `json:"last_refresh,omitempty"`
	LocalDigest      string   `json:"local_digest,omitempty"`
	LocalLastRefresh string   `json:"local_last_refresh,omitempty"`
}

// ErrActiveChild means an unconditional canonical write was intentionally
// skipped because a native Codex process may still be rotating auth.json.
var ErrActiveChild = errors.New("native Codex process is using auth.json")

// ErrLogoutIntentActive prevents even an unconditional legacy writer from
// resurrecting credentials after an explicit logout.
var ErrLogoutIntentActive = errors.New("explicit Codex logout intent is active")

// ErrCanonicalAuthConflict means two distinct verified canonical responses
// carry the same RFC3339 freshness instant. Older servers can emit this during
// a runner rotation; without a strict server-side ordering signal the wrapper
// preserves the response that landed first and fails closed.
var ErrCanonicalAuthConflict = errors.New("distinct canonical auth responses have equal last_refresh")

// CodexHome returns the state directory used by the upstream CLI. Codex honors
// CODEX_HOME; the wrapper must use the same directory or it can sync one
// auth.json while the child reads and rotates another.
func CodexHome() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("CODEX_HOME")); configured != "" {
		return filepath.Clean(configured), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".codex"), nil
}

// AuthPath returns the upstream CLI's effective auth.json location.
func AuthPath() (string, error) {
	home, err := CodexHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "auth.json"), nil
}

// LocalDigest returns the SHA256 of the current local auth.json, or empty if absent.
func LocalDigest() (string, error) {
	p, err := AuthPath()
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// ReadAuth returns the raw bytes of the local auth.json (or error if missing).
func ReadAuth() (json.RawMessage, error) {
	p, err := AuthPath()
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// CurrentAuthGeneration snapshots the exact auth.json content currently used
// by Codex. A missing file is a valid generation ({Exists:false}); other read
// failures are returned so callers do not accidentally treat permissions or
// I/O errors as absence.
func CurrentAuthGeneration() (AuthGeneration, error) {
	p, err := AuthPath()
	if err != nil {
		return AuthGeneration{}, err
	}
	return authGenerationAt(p)
}

func authGenerationAt(path string) (AuthGeneration, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return AuthGeneration{}, nil
	}
	if err != nil {
		return AuthGeneration{}, err
	}
	return generationOf(raw), nil
}

func generationOf(raw []byte) AuthGeneration {
	sum := sha256.Sum256(raw)
	return AuthGeneration{Exists: true, Digest: hex.EncodeToString(sum[:])}
}

// BackfillLastRefresh returns raw with `last_refresh` set to the current UTC
// RFC3339 timestamp when the field is absent or empty — matching the legacy
// bash `normalize_auth_json_file` behaviour that lets a plain `codex login`
// auth.json reach /auth store without bouncing on the server's RFC3339
// validation. Returns (out, modified, error). On invalid JSON or empty input
// the original bytes pass through unchanged so the server can reject them
// authoritatively.
func BackfillLastRefresh(raw []byte) (json.RawMessage, bool, error) {
	return backfillLastRefreshAt(raw, time.Now().UTC())
}

func backfillLastRefreshAt(raw []byte, stampTime time.Time) (json.RawMessage, bool, error) {
	if len(raw) == 0 {
		return json.RawMessage(raw), false, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return json.RawMessage(raw), false, nil
	}
	if cur, ok := obj["last_refresh"]; ok {
		var s string
		if err := json.Unmarshal(cur, &s); err == nil && strings.TrimSpace(s) != "" {
			return json.RawMessage(raw), false, nil
		}
	}
	stamp, _ := json.Marshal(stampTime.UTC().Format(time.RFC3339Nano))
	obj["last_refresh"] = stamp
	out, err := json.Marshal(obj)
	if err != nil {
		return json.RawMessage(raw), false, err
	}
	return json.RawMessage(out), true, nil
}

// ReadAuthForUpload returns one stable upload generation. A native `codex
// login` file has no last_refresh, so the first wrapper process stamps it once
// using the file's existing mtime and persists that exact payload locally.
// Subsequent/concurrent processes therefore submit the same timestamp and
// digest instead of independently manufacturing a new "now" on every read.
// The advisory lock is held only for this local read/write operation, never
// across a network call or interactive child.
func ReadAuthForUpload() (json.RawMessage, AuthGeneration, error) {
	payload, generation, _, err := ReadAuthForUploadState()
	return payload, generation, err
}

// ReadAuthForUploadState atomically snapshots both the stabilized auth upload
// generation and the current logout marker generation.
func ReadAuthForUploadState() (json.RawMessage, AuthGeneration, LogoutIntentGeneration, error) {
	var payload json.RawMessage
	var generation AuthGeneration
	var intentGeneration LogoutIntentGeneration
	err := withAuthLock(func(path string) error {
		var err error
		payload, generation, intentGeneration, err = readAuthForUploadStateLocked(path)
		return err
	})
	return payload, generation, intentGeneration, err
}

func readAuthForUploadStateLocked(path string) (json.RawMessage, AuthGeneration, LogoutIntentGeneration, error) {
	for attempt := 0; attempt < 3; attempt++ {
		raw, modTime, err := readAuthFileSnapshot(path)
		if err != nil {
			return nil, AuthGeneration{}, LogoutIntentGeneration{}, err
		}
		original := generationOf(raw)
		knownCanonical, knownLocal, latestLogical, err := authGenerationMetadataAt(path, original)
		if err != nil {
			return nil, AuthGeneration{}, LogoutIntentGeneration{}, err
		}
		if knownCanonical || knownLocal {
			// A verified server generation remains authoritative even if the
			// host clock later moves backwards. Wrapper-stabilized native
			// generations use the same exact-content binding. Preserve either
			// logical stamp instead of rewriting it to rolled-back wall time.
			if stamp, stampErr := LastRefreshFromRaw(raw); stampErr == nil && validLogicalAuthTimestamp(stamp) {
				if knownCanonical && (latestLogical.IsZero() || stamp.After(latestLogical)) {
					if err := rememberCanonicalGenerationLocked(path, raw); err != nil {
						return nil, AuthGeneration{}, LogoutIntentGeneration{}, err
					}
				}
				intent, intentErr := logoutIntentGenerationAt(path)
				return json.RawMessage(append([]byte(nil), raw...)), original, intent, intentErr
			}
		}
		now := time.Now()
		stabilized, modified, err := backfillLastRefreshAt(raw, clampUploadTimestamp(modTime, now))
		if err != nil {
			return nil, AuthGeneration{}, LogoutIntentGeneration{}, err
		}
		if stamped, stampErr := LastRefreshFromRaw(stabilized); stampErr == nil {
			clamped := clampUploadTimestamp(stamped, now)
			if !clamped.Equal(stamped) {
				stabilized, err = replaceLastRefresh(stabilized, clamped)
				if err != nil {
					return nil, AuthGeneration{}, LogoutIntentGeneration{}, err
				}
				modified = true
			}
		}
		// A native login is causally newer than the last canonical generation
		// observed on this host even when its mtime comes from a rolled-back
		// clock. Carry that ordering forward as local logical time.
		if !latestLogical.IsZero() {
			if stamped, stampErr := LastRefreshFromRaw(stabilized); stampErr == nil && !stamped.After(latestLogical) {
				stabilized, err = replaceLastRefresh(stabilized, latestLogical.Add(time.Nanosecond))
				if err != nil {
					return nil, AuthGeneration{}, LogoutIntentGeneration{}, err
				}
				modified = true
			}
		}
		if modified && bytes.Equal(stabilized, raw) {
			modified = false
		}
		if modified {
			wrote := false
			acquired, err := withAuthWriterLease(func() error {
				var writeErr error
				wrote, writeErr = writeAuthFileIfCurrent(path, stabilized, original)
				return writeErr
			})
			if err != nil {
				return nil, AuthGeneration{}, LogoutIntentGeneration{}, err
			}
			if !acquired {
				// The child owns the mutation window. Send a deterministic
				// inode-mtime-derived payload, retain the original generation for
				// response CAS, and leave the child's file untouched.
				intent, intentErr := logoutIntentGenerationAt(path)
				return json.RawMessage(append([]byte(nil), stabilized...)), original, intent, intentErr
			}
			if !wrote {
				continue
			}
			raw = stabilized
		}
		if stamp, stampErr := LastRefreshFromRaw(raw); stampErr == nil && validLogicalAuthTimestamp(stamp) && isValidAuthRaw(raw) {
			if err := rememberLocalGenerationLocked(path, raw); err != nil {
				return nil, AuthGeneration{}, LogoutIntentGeneration{}, err
			}
		}
		intent, err := logoutIntentGenerationAt(path)
		if err != nil {
			return nil, AuthGeneration{}, LogoutIntentGeneration{}, err
		}
		return json.RawMessage(append([]byte(nil), raw...)), generationOf(raw), intent, nil
	}
	return nil, AuthGeneration{}, LogoutIntentGeneration{}, errors.New("auth.json changed repeatedly while stabilizing upload generation")
}

// AuthUploadLease binds auth bytes and logout intent to one linearizable store
// transaction. It intentionally holds the short auth-file flock across the
// caller's bounded AuthStore request: explicit logout must order wholly before
// the upload (which sees intent and aborts) or wholly after the accepted store.
type AuthUploadLease struct {
	lock       *os.File
	path       string
	payload    json.RawMessage
	generation AuthGeneration
	intent     LogoutIntentGeneration
	once       sync.Once
	closeErr   error
}

// BeginAuthUpload starts a linearizable upload transaction. When
// acknowledgeLogout is false, an existing explicit-logout marker aborts the
// upload. Explicit login/auth-upload passes true and may acknowledge only the
// exact marker returned by IntentGeneration after the server accepts it.
func BeginAuthUpload(acknowledgeLogout bool) (*AuthUploadLease, error) {
	path, err := AuthPath()
	if err != nil {
		return nil, err
	}
	lock, err := acquireAuthLockAt(path)
	if err != nil {
		return nil, err
	}
	initialIntent, err := logoutIntentGenerationAt(path)
	if err != nil {
		_ = releaseAuthLock(lock)
		return nil, err
	}
	initialAuth, err := authGenerationAt(path)
	if err != nil {
		_ = releaseAuthLock(lock)
		return nil, err
	}
	payload, generation, intent, err := readAuthForUploadStateLocked(path)
	if err != nil {
		_ = releaseAuthLock(lock)
		if errors.Is(err, os.ErrNotExist) && initialIntent.Exists && !acknowledgeLogout {
			return nil, ErrLogoutIntentActive
		}
		return nil, err
	}
	if intent.Exists && !acknowledgeLogout {
		// Compare intent to the pre-stabilization generation. Adding the
		// wrapper-owned last_refresh field to otherwise identical native bytes
		// is not a new login and must not manufacture authority to clear logout.
		allowed, allowErr := logoutIntentSupersededByAcceptedCandidateLocked(path, initialAuth)
		if allowErr != nil {
			_ = releaseAuthLock(lock)
			return nil, allowErr
		}
		if !allowed {
			_ = releaseAuthLock(lock)
			return nil, ErrLogoutIntentActive
		}
	}
	return &AuthUploadLease{
		lock:       lock,
		path:       path,
		payload:    payload,
		generation: generation,
		intent:     intent,
	}, nil
}

// logoutIntentSupersededByAcceptedCandidateLocked reports whether the current
// usable auth is a genuinely different generation from the credential that
// logout governed. It may be offered to the server, but the marker is not
// cleared here: only a successful AuthStore acknowledgement may do that.
func logoutIntentSupersededByAcceptedCandidateLocked(path string, current AuthGeneration) (bool, error) {
	raw, err := os.ReadFile(logoutIntentPath(path))
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	var marker logoutIntent
	if err := json.Unmarshal(raw, &marker); err != nil {
		return false, fmt.Errorf("parse logout intent: %w", err)
	}
	if !current.Exists || !IsValidLocalAuth(path) {
		return false, nil
	}
	if !marker.AuthExists {
		return true, nil
	}
	return current.Digest != marker.AuthDigest, nil
}

func (l *AuthUploadLease) Payload() json.RawMessage {
	if l == nil {
		return nil
	}
	return json.RawMessage(append([]byte(nil), l.payload...))
}

func (l *AuthUploadLease) Generation() AuthGeneration {
	if l == nil {
		return AuthGeneration{}
	}
	return l.generation
}

func (l *AuthUploadLease) IntentGeneration() LogoutIntentGeneration {
	if l == nil {
		return LogoutIntentGeneration{}
	}
	return l.intent
}

// AcknowledgeObservedLogout clears only the exact marker/auth generation
// captured by this still-held transaction. No later logout can interleave.
func (l *AuthUploadLease) AcknowledgeObservedLogout() (bool, error) {
	if l == nil || l.lock == nil {
		return false, errors.New("Codex auth upload lease is closed")
	}
	current, err := authGenerationAt(l.path)
	if err != nil {
		return false, err
	}
	currentIntent, err := logoutIntentGenerationAt(l.path)
	if err != nil {
		return false, err
	}
	if current != l.generation || currentIntent != l.intent {
		return false, nil
	}
	if !currentIntent.Exists {
		return true, nil
	}
	if err := os.Remove(logoutIntentPath(l.path)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := syncDirectory(filepath.Dir(l.path)); err != nil {
		return false, err
	}
	return true, nil
}

func (l *AuthUploadLease) Close() error {
	if l == nil {
		return nil
	}
	l.once.Do(func() {
		l.closeErr = releaseAuthLock(l.lock)
		l.lock = nil
	})
	return l.closeErr
}

// readAuthFileSnapshot binds the bytes and mtime to one opened inode. Native
// Codex replaces auth.json without taking the wrapper lock; ReadFile followed
// by Stat(path) can otherwise combine the old bytes with a newly-renamed
// login's mtime and make the stale candidate appear equally new server-side.
func readAuthFileSnapshot(path string) ([]byte, time.Time, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, time.Time{}, err
	}
	defer f.Close()
	raw, err := io.ReadAll(f)
	if err != nil {
		return nil, time.Time{}, err
	}
	st, err := f.Stat()
	if err != nil {
		return nil, time.Time{}, err
	}
	return raw, st.ModTime(), nil
}

func clampUploadTimestamp(candidate, now time.Time) time.Time {
	candidate = candidate.UTC()
	now = now.UTC()
	if candidate.Before(minAuthTimestamp) {
		return minAuthTimestamp
	}
	if candidate.After(now.Add(5 * time.Minute)) {
		return now
	}
	return candidate
}

func replaceLastRefresh(raw []byte, stamp time.Time) (json.RawMessage, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(stamp.UTC().Format(time.RFC3339Nano))
	obj["last_refresh"] = encoded
	out, err := json.Marshal(obj)
	return json.RawMessage(out), err
}

// WriteAuth materializes a new auth.json from the orchestrator response,
// atomically replacing any existing file. payload is the raw JSON body the
// server returns under the `auth` key.
func WriteAuth(payload json.RawMessage) error {
	result, err := writeAuthPayload(payload, nil)
	if err == nil && !result.Written {
		return ErrActiveChild
	}
	return err
}

// WriteAuthIfCurrent atomically materializes payload only when auth.json still
// matches expected. This prevents a delayed server/runner response from
// overwriting a newer login performed while the request was in flight.
// A false,nil result means another writer won and its credential was kept.
func WriteAuthIfCurrent(payload json.RawMessage, expected AuthGeneration) (bool, error) {
	result, err := WriteAuthIfCurrentDetailed(payload, expected)
	return result.Written, err
}

// WriteAuthIfCurrentDetailed is WriteAuthIfCurrent with a typed reason for a
// safe CAS miss versus an unchanged generation blocked by an active child.
func WriteAuthIfCurrentDetailed(payload json.RawMessage, expected AuthGeneration) (AuthWriteResult, error) {
	return writeAuthPayload(payload, &expected)
}

// ConvergeAuthIfCurrent applies a verified canonical response monotonically.
// Two concurrent requests may share expected: if an older canonical lands
// first, a later/newer response CASes over it; an older/equal response never
// rolls back a fresher current generation. A small content-digest ledger marks
// generations written from verified canonical responses; an unmarked changed
// generation is conservatively a native/local write and wins regardless of
// clocks. Logout intent still blocks writes. A guarded canonical CAS may write
// alongside an active child so new invocations can receive authoritative auth;
// destructive/unconditional writers retain the exclusive child lease.
func ConvergeAuthIfCurrent(payload json.RawMessage, expected AuthGeneration) (AuthConvergenceResult, error) {
	path, err := AuthPath()
	if err != nil {
		return AuthConvergenceResult{}, err
	}
	candidateTime, candidateTimeErr := LastRefreshFromRaw(payload)
	if candidateTimeErr != nil {
		return AuthConvergenceResult{}, fmt.Errorf("canonical auth has no usable last_refresh: %w", candidateTimeErr)
	}
	if !validLogicalAuthTimestamp(candidateTime) {
		return AuthConvergenceResult{}, errors.New("canonical auth last_refresh outside accepted bounds")
	}
	candidateGeneration := generationOf(payload)
	attemptExpected := expected
	for attempt := 0; attempt < 4; attempt++ {
		writeResult, err := WriteAuthIfCurrentDetailed(payload, attemptExpected)
		if err != nil {
			return AuthConvergenceResult{}, err
		}
		current, err := CurrentAuthGeneration()
		if err != nil {
			return AuthConvergenceResult{}, err
		}
		result := AuthConvergenceResult{
			Written:              writeResult.Written,
			BlockedByActiveChild: writeResult.BlockedByActiveChild,
			Current:              current,
		}
		if writeResult.Written {
			return result, nil
		}
		if current == attemptExpected {
			return result, nil
		}
		if current == candidateGeneration {
			result.AlreadyCurrent = true
			return result, nil
		}

		// A changed usable native generation is always preserved. A generation
		// known to come from another verified canonical response is preserved
		// unless this response is strictly newer by RFC3339 instant. This is the
		// point that distinguishes a native login from C_old written by a
		// competing request that C_new should supersede.
		if IsValidLocalAuth(path) {
			knownCanonical, knownErr := canonicalGenerationKnownAt(path, current)
			if knownErr != nil {
				return result, knownErr
			}
			if !knownCanonical {
				// A generation not written from a verified server response is a
				// native/local writer. Its in-flight ordering beats this response
				// even if clock-derived timestamps would suggest otherwise.
				result.KeptNewerGeneration = true
				return result, nil
			}
			currentTime, currentTimeErr := LastRefreshOfFile(path)
			if currentTimeErr != nil {
				return result, fmt.Errorf("%w: current canonical freshness is unusable: %v", ErrCanonicalAuthConflict, currentTimeErr)
			}
			if candidateTime.Equal(currentTime) {
				return result, ErrCanonicalAuthConflict
			}
			if candidateTime.Before(currentTime) {
				result.KeptNewerGeneration = true
				return result, nil
			}
		}
		if active, markerErr := LogoutIntentActive(); markerErr != nil {
			return result, markerErr
		} else if active {
			return result, nil
		}
		attemptExpected = current
	}
	return AuthConvergenceResult{}, errors.New("auth.json changed repeatedly while converging canonical response")
}

func writeAuthPayload(payload json.RawMessage, expected *AuthGeneration) (AuthWriteResult, error) {
	if len(payload) == 0 {
		return AuthWriteResult{}, errors.New("empty auth payload")
	}
	// Ensure it's valid JSON before persisting.
	var probe any
	if err := json.Unmarshal(payload, &probe); err != nil {
		return AuthWriteResult{}, fmt.Errorf("auth payload not valid JSON: %w", err)
	}
	result := AuthWriteResult{}
	err := withAuthLock(func(path string) error {
		if expected != nil {
			current, err := authGenerationAt(path)
			if err != nil {
				return err
			}
			if current != *expected {
				return nil
			}
		}
		logoutHold, err := logoutIntentActiveLocked(path)
		if err != nil {
			return err
		}
		if logoutHold {
			if expected == nil {
				return ErrLogoutIntentActive
			}
			return nil
		}
		if err := rememberCanonicalGenerationLocked(path, payload); err != nil {
			return err
		}
		wroteNow := false
		if expected != nil {
			wroteNow, err = atomicWriteFileIfCurrent(path, payload, 0o600, expected)
			if err != nil {
				return err
			}
			result.Written = wroteNow
			return nil
		}
		acquired, err := withAuthWriterLease(func() error {
			var writeErr error
			wroteNow, writeErr = atomicWriteFileIfCurrent(path, payload, 0o600, expected)
			return writeErr
		})
		if err != nil {
			return err
		}
		if !acquired {
			result.BlockedByActiveChild = true
			return nil
		}
		result.Written = wroteNow
		return nil
	})
	return result, err
}

func canonicalGenerationLedgerPath(authPath string) string {
	return filepath.Join(filepath.Dir(authPath), canonicalGenerationLedgerFile)
}

// rememberCanonicalGenerationLocked records verified server-response content
// before its auth rename. A bounded digest ledger supplies cross-process
// provenance for convergence: another response may supersede C_old by RFC3339
// freshness, while an unrecognized generation is conservatively a native login.
func rememberCanonicalGenerationLocked(authPath string, payload []byte) error {
	generation := generationOf(payload)
	if !generation.Exists || generation.Digest == "" {
		return nil
	}
	path := canonicalGenerationLedgerPath(authPath)
	ledger := canonicalGenerationLedger{}
	if raw, err := os.ReadFile(path); err == nil {
		if jsonErr := json.Unmarshal(raw, &ledger); jsonErr != nil {
			return fmt.Errorf("parse canonical auth generation ledger: %w", jsonErr)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	digests := make([]string, 0, 16)
	digests = append(digests, generation.Digest)
	for _, digest := range ledger.Digests {
		if digest == "" || digest == generation.Digest {
			continue
		}
		digests = append(digests, digest)
		if len(digests) == 16 {
			break
		}
	}
	latestRefresh := ledger.LastRefresh
	if stamp, stampErr := LastRefreshFromRaw(payload); stampErr == nil && validLogicalAuthTimestamp(stamp) {
		currentLatest, currentErr := parseGenerationLedgerRefresh(ledger.LastRefresh)
		if currentErr != nil {
			return currentErr
		}
		if currentLatest.IsZero() || stamp.After(currentLatest) {
			latestRefresh = stamp.UTC().Format(time.RFC3339Nano)
		}
	}
	ledger.Digests = digests
	ledger.LastRefresh = latestRefresh
	raw, err := json.Marshal(ledger)
	if err != nil {
		return err
	}
	return atomicWriteFile(path, raw, 0o600)
}

func canonicalGenerationKnownAt(authPath string, generation AuthGeneration) (bool, error) {
	known, _, _, err := authGenerationMetadataAt(authPath, generation)
	return known, err
}

func trustedGenerationKnownAt(authPath string, generation AuthGeneration) (bool, error) {
	knownCanonical, knownLocal, _, err := authGenerationMetadataAt(authPath, generation)
	return knownCanonical || knownLocal, err
}

func authGenerationMetadataAt(authPath string, generation AuthGeneration) (bool, bool, time.Time, error) {
	if !generation.Exists || generation.Digest == "" {
		return false, false, time.Time{}, nil
	}
	raw, err := os.ReadFile(canonicalGenerationLedgerPath(authPath))
	if errors.Is(err, os.ErrNotExist) {
		return false, false, time.Time{}, nil
	}
	if err != nil {
		return false, false, time.Time{}, err
	}
	var ledger canonicalGenerationLedger
	if err := json.Unmarshal(raw, &ledger); err != nil {
		return false, false, time.Time{}, fmt.Errorf("parse canonical auth generation ledger: %w", err)
	}
	canonicalRefresh, err := parseGenerationLedgerRefresh(ledger.LastRefresh)
	if err != nil {
		return false, false, time.Time{}, err
	}
	localRefresh, err := parseGenerationLedgerRefresh(ledger.LocalLastRefresh)
	if err != nil {
		return false, false, time.Time{}, err
	}
	latestRefresh := canonicalRefresh
	if localRefresh.After(latestRefresh) {
		latestRefresh = localRefresh
	}
	knownCanonical := false
	for _, digest := range ledger.Digests {
		if digest == generation.Digest {
			knownCanonical = true
			break
		}
	}
	knownLocal := ledger.LocalDigest == generation.Digest && !localRefresh.IsZero()
	return knownCanonical, knownLocal, latestRefresh, nil
}

func rememberLocalGenerationLocked(authPath string, payload []byte) error {
	generation := generationOf(payload)
	stamp, err := LastRefreshFromRaw(payload)
	if err != nil || !validLogicalAuthTimestamp(stamp) {
		return errors.New("local auth generation has no usable last_refresh")
	}
	path := canonicalGenerationLedgerPath(authPath)
	ledger := canonicalGenerationLedger{}
	if raw, readErr := os.ReadFile(path); readErr == nil {
		if jsonErr := json.Unmarshal(raw, &ledger); jsonErr != nil {
			return fmt.Errorf("parse canonical auth generation ledger: %w", jsonErr)
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	ledger.LocalDigest = generation.Digest
	ledger.LocalLastRefresh = stamp.UTC().Format(time.RFC3339Nano)
	raw, err := json.Marshal(ledger)
	if err != nil {
		return err
	}
	return atomicWriteFile(path, raw, 0o600)
}

func parseGenerationLedgerRefresh(value string) (time.Time, error) {
	if strings.TrimSpace(value) == "" {
		return time.Time{}, nil
	}
	stamp, err := parseISO8601(value)
	if err != nil || !validLogicalAuthTimestamp(stamp) {
		if err == nil {
			err = errors.New("timestamp predates minimum auth epoch")
		}
		return time.Time{}, fmt.Errorf("parse auth generation ledger last_refresh: %w", err)
	}
	return stamp.UTC(), nil
}

// RemoveAuthIfCurrent removes auth.json only when it still matches expected.
// It is used by insecure-host cleanup so a concurrent fresh login is never
// deleted by a session that is finishing with an older generation.
func RemoveAuthIfCurrent(expected AuthGeneration) (bool, error) {
	path, err := AuthPath()
	if err != nil {
		return false, err
	}
	return removeAuthIfCurrentAt(path, expected)
}

func removeAuthIfCurrentAt(path string, expected AuthGeneration) (bool, error) {
	removed := false
	err := withAuthLockAt(path, func(path string) error {
		current, err := authGenerationAt(path)
		if err != nil {
			return err
		}
		if current != expected || !current.Exists {
			return nil
		}
		acquired, err := withAuthWriterLeaseAt(filepath.Dir(path), func() error {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if err := syncDirectory(filepath.Dir(path)); err != nil {
				return err
			}
			removed = true
			return nil
		})
		if err != nil {
			return err
		}
		if !acquired {
			return nil
		}
		return nil
	})
	return removed, err
}

type logoutIntent struct {
	CreatedAt  string `json:"created_at"`
	AuthExists bool   `json:"auth_exists"`
	AuthDigest string `json:"auth_digest,omitempty"`
	Nonce      string `json:"nonce,omitempty"`
}

// MarkLogoutIntent records an explicit successful `cdx logout`, provided the
// local auth generation has not changed since the command returned. The marker
// prevents the next managed retrieve from silently restoring fleet auth.
func MarkLogoutIntent(expected AuthGeneration) (bool, error) {
	marked := false
	err := withAuthLock(func(path string) error {
		current, err := authGenerationAt(path)
		if err != nil {
			return err
		}
		if current != expected {
			return nil
		}
		nonceBytes := make([]byte, 16)
		if _, err := rand.Read(nonceBytes); err != nil {
			return fmt.Errorf("generate logout intent nonce: %w", err)
		}
		intent := logoutIntent{
			CreatedAt:  time.Now().UTC().Format(time.RFC3339Nano),
			AuthExists: current.Exists,
			AuthDigest: current.Digest,
			Nonce:      hex.EncodeToString(nonceBytes),
		}
		raw, err := json.Marshal(intent)
		if err != nil {
			return err
		}
		if err := atomicWriteFile(logoutIntentPath(path), raw, 0o600); err != nil {
			return err
		}
		marked = true
		return nil
	})
	return marked, err
}

// LogoutIntentActive reports whether the last explicit logout still applies.
// A different file alone never clears intent: a concurrent native child can
// rotate auth after logout. Only an explicitly accepted login/auth-upload may
// acknowledge the marker through ClearLogoutIntentIfUnchanged.
func LogoutIntentActive() (bool, error) {
	active := false
	err := withAuthLock(func(path string) error {
		var err error
		active, err = logoutIntentActiveLocked(path)
		return err
	})
	return active, err
}

func logoutIntentActiveLocked(path string) (bool, error) {
	markerPath := logoutIntentPath(path)
	raw, err := os.ReadFile(markerPath)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	var intent logoutIntent
	if err := json.Unmarshal(raw, &intent); err != nil {
		// A malformed marker is treated conservatively as an active logout;
		// silently restoring credentials would violate explicit user intent.
		return true, fmt.Errorf("parse logout intent: %w", err)
	}
	return true, nil
}

// ClearLogoutIntent acknowledges a later successful login/upload.
func ClearLogoutIntent() error {
	return withAuthLock(func(path string) error {
		err := os.Remove(logoutIntentPath(path))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		return syncDirectory(filepath.Dir(path))
	})
}

// ClearLogoutIntentIfCurrent clears the marker only if the uploaded local
// generation is still current. A logout that happens while a store request is
// in flight changes the generation and therefore keeps its newer intent.
func ClearLogoutIntentIfCurrent(expected AuthGeneration) (bool, error) {
	cleared := false
	err := withAuthLock(func(path string) error {
		current, err := authGenerationAt(path)
		if err != nil {
			return err
		}
		if current != expected {
			return nil
		}
		err = os.Remove(logoutIntentPath(path))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := syncDirectory(filepath.Dir(path)); err != nil {
			return err
		}
		cleared = true
		return nil
	})
	return cleared, err
}

// ClearLogoutIntentIfUnchanged clears only the exact marker seen alongside
// expected auth before a request. A marker created/replaced during the request
// has a different digest and is preserved.
func ClearLogoutIntentIfUnchanged(expected AuthGeneration, expectedIntent LogoutIntentGeneration) (bool, error) {
	cleared := false
	err := withAuthLock(func(path string) error {
		current, err := authGenerationAt(path)
		if err != nil {
			return err
		}
		if current != expected {
			return nil
		}
		currentIntent, err := logoutIntentGenerationAt(path)
		if err != nil {
			return err
		}
		if currentIntent != expectedIntent || !currentIntent.Exists {
			return nil
		}
		if err := os.Remove(logoutIntentPath(path)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := syncDirectory(filepath.Dir(path)); err != nil {
			return err
		}
		cleared = true
		return nil
	})
	return cleared, err
}

func logoutIntentGenerationAt(authPath string) (LogoutIntentGeneration, error) {
	raw, err := os.ReadFile(logoutIntentPath(authPath))
	if errors.Is(err, os.ErrNotExist) {
		return LogoutIntentGeneration{}, nil
	}
	if err != nil {
		return LogoutIntentGeneration{}, err
	}
	sum := sha256.Sum256(raw)
	return LogoutIntentGeneration{Exists: true, Digest: hex.EncodeToString(sum[:])}, nil
}

// CurrentLogoutIntentGeneration snapshots marker bytes without applying the
// automatic new-login clearing policy. Explicit login uses it to decide that
// even byte-identical credentials must be re-accepted before old intent clears.
func CurrentLogoutIntentGeneration() (LogoutIntentGeneration, error) {
	var generation LogoutIntentGeneration
	err := withAuthLock(func(path string) error {
		var err error
		generation, err = logoutIntentGenerationAt(path)
		return err
	})
	return generation, err
}

func logoutIntentPath(authPath string) string {
	return filepath.Join(filepath.Dir(authPath), ".cdx-logout-intent.json")
}

func withAuthLock(fn func(authPath string) error) error {
	authPath, err := AuthPath()
	if err != nil {
		return err
	}
	return withAuthLockAt(authPath, fn)
}

func withAuthLockAt(authPath string, fn func(authPath string) error) error {
	lock, err := acquireAuthLockAt(authPath)
	if err != nil {
		return err
	}
	defer releaseAuthLock(lock) //nolint:errcheck
	return fn(authPath)
}

func acquireAuthLockAt(authPath string) (*os.File, error) {
	dir := filepath.Dir(authPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	lockPath := filepath.Join(dir, ".cdx-auth.lock")
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open auth lock: %w", err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("lock auth state: %w", err)
	}
	return lock, nil
}

func releaseAuthLock(lock *os.File) error {
	if lock == nil {
		return nil
	}
	unlockErr := syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	return errors.Join(unlockErr, lock.Close())
}

func writeAuthFileIfCurrent(path string, payload []byte, expected AuthGeneration) (bool, error) {
	return atomicWriteFileIfCurrent(path, payload, 0o600, &expected)
}

// withAuthWriterLease prevents wrapper-managed auth writes from overlapping a
// native Codex child. The lease is non-blocking by design: a delayed canonical
// response skips its write instead of waiting until the child exits and then
// clobbering a login/logout that happened during that process.
func withAuthWriterLease(fn func() error) (bool, error) {
	home, err := CodexHome()
	if err != nil {
		return false, err
	}
	return withAuthWriterLeaseAt(home, fn)
}

func withAuthWriterLeaseAt(home string, fn func() error) (bool, error) {
	lease, err := tryAcquireAuthWriterAt(home)
	if errors.Is(err, ipc.ErrHeld) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	err = fn()
	releaseErr := lease.Release()
	return true, errors.Join(err, releaseErr)
}

func atomicWriteFile(path string, payload []byte, mode os.FileMode) error {
	_, err := atomicWriteFileIfCurrent(path, payload, mode, nil)
	return err
}

func atomicWriteFileIfCurrent(path string, payload []byte, mode os.FileMode, expected *AuthGeneration) (bool, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return false, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*")
	if err != nil {
		return false, err
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(mode); err != nil {
		cleanup()
		return false, err
	}
	if _, err := tmp.Write(payload); err != nil {
		cleanup()
		return false, err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return false, err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return false, err
	}
	if expected != nil {
		current, err := authGenerationAt(path)
		if err != nil {
			_ = os.Remove(tmpName)
			return false, err
		}
		if current != *expected {
			_ = os.Remove(tmpName)
			return false, nil
		}
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return false, err
	}
	if err := syncDirectory(filepath.Dir(path)); err != nil {
		return false, err
	}
	return true, nil
}

// syncDirectory makes rename/remove metadata durable where supported. Some
// otherwise-valid filesystems and platforms reject directory fsync with
// EINVAL/ENOTSUP; those are portability limitations, not failed auth writes.
func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open auth directory for sync: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		if unsupportedDirectorySync(err) {
			return nil
		}
		return fmt.Errorf("sync auth directory: %w", err)
	}
	return nil
}

func unsupportedDirectorySync(err error) bool {
	return errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ENOTSUP)
}
