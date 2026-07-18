package claude

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	generationStateFile    = "generation.json"
	generationStateVersion = 1
)

var ErrAuthUploadBlockedByLogout = errors.New("explicit Claude logout became active before auth upload")

// AuthGeneration identifies the exact authoritative Claude-native credential
// content observed before a network call. It deliberately excludes mtimes:
// rewriting byte-identical credentials does not create a new auth generation.
type AuthGeneration struct {
	Exists bool
	Digest string
}

// AuthSnapshot is a coherent read of Claude Code's authoritative credential
// file. Upload contains the same credentials plus the wrapper's stable
// last_refresh generation stamp.
type AuthSnapshot struct {
	Path       string
	Raw        json.RawMessage
	Upload     json.RawMessage
	Generation AuthGeneration
	// ServerDigest is the digest of the last authoritative canonical envelope
	// that materialized this exact native digest. It lets status/bootstrap use a
	// server-comparable digest even though Claude's native file omits fleet fields.
	ServerDigest string
	// LastRefresh is the stable wrapper generation timestamp when available,
	// otherwise the authoritative native file's mtime.
	LastRefresh time.Time
	Usable      bool
}

type generationState struct {
	Version         int    `json:"version,omitempty"`
	Digest          string `json:"digest"`
	LastRefresh     string `json:"last_refresh"`
	CanonicalDigest string `json:"canonical_digest,omitempty"`
}

func (s AuthSnapshot) DigestForServer() string {
	if validDigest(s.ServerDigest) {
		return s.ServerDigest
	}
	return s.Generation.Digest
}

// AuthPath returns the only credential path Claude Code itself consumes.
// ~/.clx/auth/credentials.json is a compatibility mirror, never an auth source:
// otherwise a stale sidecar can green-light a missing native file or resurrect
// an intentional Claude logout.
func AuthPath() (string, error) {
	path, _, err := authPaths()
	return path, err
}

func authPaths() (claudePath, clxPath string, err error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	return filepath.Join(home, ".claude", ".credentials.json"), filepath.Join(home, ".clx", "auth", "credentials.json"), nil
}

// AuthCandidatePaths returns the authoritative path followed by its legacy
// compatibility mirror. Callers may use this for cleanup/diagnostics only.
func AuthCandidatePaths() ([]string, error) {
	claudePath, clxPath, err := authPaths()
	if err != nil {
		return nil, err
	}
	return []string{claudePath, clxPath}, nil
}

func LocalDigest() (string, error) {
	snap, err := ReadAuthSnapshot(false)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return snap.DigestForServer(), nil
}

// ReadAuth returns the raw bytes of the local credentials.json.
func ReadAuth() (json.RawMessage, error) {
	snap, err := ReadAuthSnapshot(false)
	if err != nil {
		return nil, err
	}
	return snap.Raw, nil
}

// ReadAuthForUpload returns a server-store-ready copy of the authoritative
// credentials. It persists only digest-bound generation metadata; the native
// credential file changes only after the server accepts canonical auth.
func ReadAuthForUpload() (json.RawMessage, string, error) {
	snap, err := ReadAuthSnapshot(true)
	if err != nil {
		return nil, "", err
	}
	return snap.Upload, snap.Path, nil
}

// ReadAuthForUploadSnapshot returns upload bytes and the exact native-file
// generation they came from, then releases its short auth lock. Candidate
// stores that must order against logout use BeginAuthUploadState or
// BeginChangedAuthUploadState and deliberately keep that transaction lease
// through the bounded network call.
func ReadAuthForUploadSnapshot() (AuthSnapshot, error) {
	return ReadAuthSnapshot(true)
}

// ReadAuthForRetrieveSnapshot returns the exact native generation for digest
// comparison while offering a candidate only when the native JSON is
// structurally usable. Invalid JSON therefore remains replaceable by verified
// canonical auth instead of aborting bootstrap during upload normalization.
func ReadAuthForRetrieveSnapshot() (AuthSnapshot, error) {
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return AuthSnapshot{}, err
	}
	defer unlock()
	snap, err := readAuthSnapshotLocked(paths, false)
	if err != nil || !snap.Usable {
		return snap, err
	}
	return readAuthSnapshotLocked(paths, true)
}

// ReadAuthForUploadState atomically snapshots the stabilized native upload and
// the exact logout marker bytes used by an explicit store operation.
func ReadAuthForUploadState() (AuthSnapshot, LogoutIntentGeneration, error) {
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return AuthSnapshot{}, LogoutIntentGeneration{}, err
	}
	defer unlock()
	snap, err := readAuthSnapshotLocked(paths, true)
	if err != nil {
		return AuthSnapshot{}, LogoutIntentGeneration{}, err
	}
	intent, err := logoutIntentGenerationAt(paths.logout)
	if err != nil {
		return AuthSnapshot{}, LogoutIntentGeneration{}, err
	}
	return snap, intent, nil
}

// BeginAuthUploadState takes a linearizable auth+logout-intent snapshot for an
// explicit login/auth-upload and returns an idempotent release function. The
// caller deliberately keeps this lease through AuthStore: an explicit logout
// then orders wholly before or wholly after the store. Existing intent is
// returned unchanged because a later explicitly accepted login may acknowledge
// it with ClearLogoutIntentIfUnchanged.
func BeginAuthUploadState() (AuthSnapshot, LogoutIntentGeneration, func(), error) {
	return beginAuthUploadState()
}

// BeginChangedAuthUploadState is the automatic candidate/post-run spelling.
// Callers abort only when intent.Blocks(snapshot); a different usable native
// generation must be uploaded and may acknowledge the exact marker after the
// server accepts it.
func BeginChangedAuthUploadState() (AuthSnapshot, LogoutIntentGeneration, func(), error) {
	return beginAuthUploadState()
}

func beginAuthUploadState() (AuthSnapshot, LogoutIntentGeneration, func(), error) {
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return AuthSnapshot{}, LogoutIntentGeneration{}, nil, err
	}
	var once sync.Once
	release := func() { once.Do(unlock) }
	snap, err := readAuthSnapshotLocked(paths, true)
	if err != nil {
		release()
		return AuthSnapshot{}, LogoutIntentGeneration{}, nil, err
	}
	intent, err := logoutIntentGenerationAt(paths.logout)
	if err != nil {
		release()
		return AuthSnapshot{}, LogoutIntentGeneration{}, nil, err
	}
	return snap, intent, release, nil
}

func ReadAuthForUploadFromPath(path string) (json.RawMessage, error) {
	authPath, err := AuthPath()
	if err != nil {
		return nil, err
	}
	if filepath.Clean(path) != filepath.Clean(authPath) {
		return nil, fmt.Errorf("refusing non-authoritative Claude auth path %s", path)
	}
	snap, err := ReadAuthSnapshot(true)
	if err != nil {
		return nil, err
	}
	return snap.Upload, nil
}

// ReadAuthSnapshot reads the authoritative native file while holding the short
// cross-process auth lock. When forUpload is true, a missing last_refresh is
// assigned once per native-content digest and persisted in wrapper state. Every
// concurrent reader of identical native content therefore uploads one stable
// generation rather than independently inventing "now".
func ReadAuthSnapshot(forUpload bool) (AuthSnapshot, error) {
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return AuthSnapshot{}, err
	}
	defer unlock()
	return readAuthSnapshotLocked(paths, forUpload)
}

func readAuthSnapshotLocked(paths authFileSet, forUpload bool) (AuthSnapshot, error) {
	raw, info, err := readNative(paths.claude)
	if err != nil {
		return AuthSnapshot{Path: paths.claude}, err
	}
	digest := digestBytes(raw)
	snap := AuthSnapshot{
		Path:        paths.claude,
		Raw:         json.RawMessage(raw),
		Generation:  AuthGeneration{Exists: true, Digest: digest},
		LastRefresh: info.ModTime().UTC(),
		Usable:      isUsableAuth(raw),
	}
	if stamp, err := LastRefreshFromRaw(raw); err == nil {
		snap.LastRefresh = stamp
	}
	if state := readGenerationState(paths.generation); state.Digest == digest {
		if validDigest(state.CanonicalDigest) {
			snap.ServerDigest = state.CanonicalDigest
		}
		if validGenerationStateRefresh(state) {
			if stamp, err := time.Parse(time.RFC3339Nano, state.LastRefresh); err == nil {
				snap.LastRefresh = stamp.UTC()
			}
		}
	}
	if !forUpload {
		return snap, nil
	}

	stamp, err := stableLastRefreshLocked(paths, raw, info, digest)
	if err != nil {
		return AuthSnapshot{}, err
	}
	snap.Upload, err = withLastRefresh(json.RawMessage(raw), stamp)
	if err != nil {
		return AuthSnapshot{}, err
	}
	if parsed, parseErr := time.Parse(time.RFC3339Nano, stamp); parseErr == nil {
		snap.LastRefresh = parsed.UTC()
	}
	return snap, nil
}

// ServerAuthMayReplace is the shared materialization gate for bundle, legacy,
// status, and accepted store responses. A known-bad canonical is never written.
// A usable newer local login wins over an older canonical unless the API says
// that exact candidate was definitively rejected and the canonical is verified.
func ServerAuthMayReplace(local AuthSnapshot, canonical json.RawMessage, canonicalLastRefresh, verificationState string, candidateRejectedDefinitive bool) bool {
	verificationState = strings.ToLower(strings.TrimSpace(verificationState))
	if verificationState == "failed" {
		return false
	}
	if !local.Generation.Exists || !local.Usable {
		return true
	}
	if candidateRejectedDefinitive && verificationState == "verified" {
		return true
	}
	canonicalRefresh, err := parseISO8601(strings.TrimSpace(canonicalLastRefresh))
	if err != nil {
		canonicalRefresh, err = LastRefreshFromRaw(canonical)
	}
	if err != nil || local.LastRefresh.IsZero() {
		return false
	}
	return !local.LastRefresh.After(canonicalRefresh)
}

// BlockedCanonicalWriteError decides whether a generation-guarded canonical
// write that returned applied=false is safe to skip. A different newer usable
// local generation is a genuine CAS loss and wins. If the request generation is
// still unchanged, however, the write was blocked (normally by an active native
// child) and the caller must fail closed rather than consume credentials the
// server explicitly replaced. Logout intent remains an intentional safe block.
func BlockedCanonicalWriteError(request AuthSnapshot, canonical json.RawMessage, candidateRejectedDefinitive bool) error {
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return fmt.Errorf("lock Claude credentials after blocked canonical write: %w", err)
	}
	defer unlock()
	latest, err := readAuthSnapshotLocked(paths, false)
	if errors.Is(err, os.ErrNotExist) {
		intent, intentErr := logoutIntentGenerationAt(paths.logout)
		if intentErr != nil {
			return fmt.Errorf("inspect Claude logout intent after blocked canonical write: %w", intentErr)
		}
		if intent.Exists {
			return nil
		}
		return errors.New("canonical Claude credentials were required but local credentials are absent")
	}
	if err != nil {
		return fmt.Errorf("inspect Claude credentials after blocked canonical write: %w", err)
	}
	logoutActive, logoutErr := logoutIntentActiveLocked(paths, latest.Generation)
	if logoutErr != nil {
		return fmt.Errorf("inspect Claude logout intent after blocked canonical write: %w", logoutErr)
	}
	if logoutActive {
		return nil
	}
	if !latest.Usable {
		return errors.New("canonical Claude credentials were required but local credentials are unusable")
	}
	if latest.Generation == request.Generation {
		if candidateRejectedDefinitive {
			return errors.New("the current local Claude credential generation was definitively rejected and canonical repair was blocked by an active child")
		}
		return errors.New("canonical Claude credentials were required but the unchanged local generation could not be replaced while a Claude child was active")
	}

	// A different raw native generation is a genuine newer login and wins. A
	// different wrapper-materialized canonical is safe only when it is strictly
	// newer than this response (or carries identical native credentials). Equal
	// timestamps with different digests are ambiguous runner rotations and must
	// not be reported as successful convergence.
	state := readGenerationState(paths.generation)
	if state.Digest != latest.Generation.Digest || !validDigest(state.CanonicalDigest) {
		return nil
	}
	native, nativeErr := extractClaudeFormat(canonical)
	if nativeErr != nil {
		return fmt.Errorf("normalize blocked canonical Claude credentials: %w", nativeErr)
	}
	if digestBytes(native) == latest.Generation.Digest {
		return nil
	}
	incomingStamp := lastRefreshFromPayload(canonical)
	if !validLogicalRefresh(incomingStamp) || !validGenerationStateRefresh(state) {
		return errors.New("canonical Claude response order is ambiguous because stable last_refresh metadata is missing")
	}
	incomingTime, incomingErr := time.Parse(time.RFC3339Nano, incomingStamp)
	currentTime, currentErr := time.Parse(time.RFC3339Nano, state.LastRefresh)
	if incomingErr != nil || currentErr != nil {
		return errors.New("canonical Claude response order is ambiguous because stable last_refresh metadata is invalid")
	}
	if !incomingTime.Before(currentTime) {
		return errors.New("canonical Claude response order is ambiguous: equal/newer last_refresh has different credential content but was not applied")
	}
	return nil
}

func readNative(path string) ([]byte, os.FileInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close() //nolint:errcheck
	raw, err := io.ReadAll(f)
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	return raw, info, nil
}

func WriteAuth(payload json.RawMessage) error {
	_, err := writeAuth(payload, "", nil)
	return err
}

// WriteAuthIfCurrent applies server-returned auth when the authoritative local
// generation still matches what the request used. On a mismatch, it may also
// advance a prior wrapper-materialized canonical generation when the incoming
// stable last_refresh is strictly newer. Raw native logins never have that
// canonical provenance and therefore still win response-order races.
func WriteAuthIfCurrent(payload json.RawMessage, expected AuthGeneration) (bool, error) {
	return writeAuth(payload, "", &expected)
}

// WriteAuthIfCurrentWithDigest is WriteAuthIfCurrent plus the API's canonical
// digest, which is persisted only for the matching native generation.
func WriteAuthIfCurrentWithDigest(payload json.RawMessage, canonicalDigest string, expected AuthGeneration) (bool, error) {
	return writeAuth(payload, canonicalDigest, &expected)
}

func writeAuth(payload json.RawMessage, canonicalDigest string, expected *AuthGeneration) (bool, error) {
	if len(payload) == 0 {
		return false, errors.New("empty auth payload")
	}
	// Claude Code reads ~/.claude/.credentials.json and expects ONLY the
	// claudeAiOauth block. The orchestrator payload may also carry legacy
	// `last_refresh` / `auths` fields. Strip them so Claude does not fall
	// back to the legacy auth flow or show the login wizard.
	toWrite, err := extractClaudeFormat(payload)
	if err != nil {
		return false, fmt.Errorf("auth payload not valid JSON: %w", err)
	}
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return false, err
	}
	defer unlock()
	childLease, err := tryAcquireAuthChildWriter()
	if err != nil {
		if errors.Is(err, ErrAuthChildActive) && expected != nil {
			return false, nil
		}
		return false, err
	}
	defer childLease.Close() //nolint:errcheck

	incomingStamp := lastRefreshFromPayload(payload)
	current, err := generationAt(paths.claude)
	if err != nil {
		return false, err
	}
	commitExpected := expected
	if expected != nil {
		active, err := logoutIntentActiveLocked(paths, current)
		if err != nil {
			return false, err
		}
		if active {
			return false, nil
		}
		if current != *expected {
			state := readGenerationState(paths.generation)
			if state.Digest != current.Digest || !validDigest(state.CanonicalDigest) || !refreshStrictlyAfter(incomingStamp, state.LastRefresh) {
				return false, nil
			}
			// Another response for the same request generation committed first.
			// Advance only from that exact wrapper-materialized native generation;
			// commitAuthPairLocked re-checks it after staging to protect a raw login.
			permitted := current
			commitExpected = &permitted
		}
	}

	stamp := incomingStamp
	if stamp == "" {
		stamp = stableTimestamp(time.Now().UTC(), "", false)
	}
	if !validDigest(canonicalDigest) {
		canonicalDigest = digestBytes(payload)
	}
	state := generationState{Version: generationStateVersion, Digest: digestBytes(toWrite), LastRefresh: stamp, CanonicalDigest: canonicalDigest}
	stateRaw, err := json.Marshal(state)
	if err != nil {
		return false, err
	}
	applied, err := commitAuthPairLocked(paths, toWrite, stateRaw, commitExpected)
	if err != nil {
		return false, err
	}
	if !applied {
		return false, nil
	}
	if err := clearLogoutIntentLocked(paths); err != nil {
		return false, err
	}
	return true, nil
}

func refreshStrictlyAfter(candidate, current string) bool {
	if !validLogicalRefresh(candidate) || !validLogicalRefresh(current) {
		return false
	}
	candidateTime, candidateErr := time.Parse(time.RFC3339Nano, candidate)
	currentTime, currentErr := time.Parse(time.RFC3339Nano, current)
	return candidateErr == nil && currentErr == nil && candidateTime.After(currentTime)
}

func generationAt(path string) (AuthGeneration, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return AuthGeneration{}, nil
	}
	if err != nil {
		return AuthGeneration{}, err
	}
	return AuthGeneration{Exists: true, Digest: digestBytes(raw)}, nil
}

func digestBytes(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func validDigest(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func stableLastRefreshLocked(paths authFileSet, raw []byte, info os.FileInfo, digest string) (string, error) {
	if stamp := lastRefreshFromPayload(raw); stamp != "" {
		return stamp, nil
	}
	previous := readGenerationState(paths.generation)
	if previous.Digest == digest && validGenerationStateRefresh(previous) {
		if previous.Version != generationStateVersion {
			previous.Version = generationStateVersion
			stateRaw, err := json.Marshal(previous)
			if err != nil {
				return "", err
			}
			if err := atomicWriteLocked(paths.generation, stateRaw, 0o600); err != nil {
				return "", err
			}
		}
		return previous.LastRefresh, nil
	}
	previousStamp := ""
	trustPrevious := false
	if validGenerationStateRefresh(previous) {
		previousStamp = previous.LastRefresh
		trustPrevious = trustedGenerationState(previous)
	}
	stamp := stableTimestamp(info.ModTime().UTC(), previousStamp, trustPrevious)
	stateRaw, err := json.Marshal(generationState{Version: generationStateVersion, Digest: digest, LastRefresh: stamp})
	if err != nil {
		return "", err
	}
	if err := atomicWriteLocked(paths.generation, stateRaw, 0o600); err != nil {
		return "", err
	}
	return stamp, nil
}

func stableTimestamp(candidate time.Time, previous string, trustPrevious bool) string {
	now := time.Now().UTC()
	if candidate.Year() < 2000 || candidate.After(now.Add(5*time.Minute)) {
		candidate = now
	}
	if prev, err := time.Parse(time.RFC3339Nano, previous); err == nil && !candidate.After(prev) {
		candidate = prev.Add(time.Nanosecond)
		if !trustPrevious && candidate.After(now.Add(5*time.Minute)) {
			candidate = now
		}
	}
	return candidate.UTC().Format(time.RFC3339Nano)
}

func validRefresh(value string) bool {
	if strings.TrimSpace(value) == "" {
		return false
	}
	ts, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return false
	}
	now := time.Now().UTC()
	return ts.Year() >= 2000 && !ts.After(now.Add(5*time.Minute))
}

// validLogicalRefresh validates an ordering stamp without comparing it to the
// local wall clock. A persisted wrapper generation can legitimately appear in
// the future after the host clock moves backwards; the API remains the
// authority for its own +5 minute acceptance bound.
func validLogicalRefresh(value string) bool {
	if strings.TrimSpace(value) == "" {
		return false
	}
	ts, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && ts.Year() >= 2000
}

func validGenerationStateRefresh(state generationState) bool {
	if trustedGenerationState(state) {
		return validLogicalRefresh(state.LastRefresh)
	}
	// Legacy/unversioned metadata retains the historical local-clock sanity
	// check. Reading it once rewrites it into the versioned monotonic format.
	return validRefresh(state.LastRefresh)
}

func trustedGenerationState(state generationState) bool {
	return state.Version == generationStateVersion ||
		(state.Version == 0 && validDigest(state.CanonicalDigest))
}

func lastRefreshFromPayload(payload []byte) string {
	var doc struct {
		LastRefresh string `json:"last_refresh"`
	}
	if json.Unmarshal(payload, &doc) != nil || !validLogicalRefresh(doc.LastRefresh) {
		return ""
	}
	return strings.TrimSpace(doc.LastRefresh)
}

func withLastRefresh(payload json.RawMessage, stamp string) (json.RawMessage, error) {
	var obj map[string]any
	if err := json.Unmarshal(payload, &obj); err != nil {
		return nil, err
	}
	obj["last_refresh"] = stamp
	out, err := json.Marshal(obj)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(out), nil
}

// AuthMatchesCanonical compares the on-disk Claude credential shape with the
// shape WriteAuth would materialize from a fleet payload. Fleet OAuth payloads
// carry last_refresh, while Claude Code's native file must not; comparing raw
// digests would therefore report a permanent false mismatch after every sync.
func AuthMatchesCanonical(path string, payload json.RawMessage) bool {
	local, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	normalized, err := extractClaudeFormat(payload)
	if err != nil {
		return false
	}
	var localDoc, canonicalDoc any
	if err := json.Unmarshal(local, &localDoc); err != nil {
		return false
	}
	if err := json.Unmarshal(normalized, &canonicalDoc); err != nil {
		return false
	}
	return reflect.DeepEqual(localDoc, canonicalDoc)
}

// extractClaudeFormat returns a credentials JSON that Claude Code accepts.
// When the payload contains a claudeAiOauth block it returns just that block;
// otherwise it returns the original payload unchanged (API-key-only setups).
func extractClaudeFormat(payload json.RawMessage) (json.RawMessage, error) {
	var raw struct {
		ClaudeAIOauth json.RawMessage `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, err
	}
	if len(raw.ClaudeAIOauth) == 0 {
		return payload, nil
	}
	out, err := json.Marshal(map[string]json.RawMessage{"claudeAiOauth": raw.ClaudeAIOauth})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// HasUsableAuth reports whether Claude Code's authoritative native credential
// file exists and contains at least one structurally usable token.
func HasUsableAuth() bool {
	snap, err := ReadAuthSnapshot(false)
	return err == nil && snap.Usable
}

func isUsableAuth(raw []byte) bool {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return false
	}
	return hasAnyClaudeToken(doc)
}

type authFileSet struct {
	claude       string
	clx          string
	generation   string
	logout       string
	purgeRequest string
	lock         string
	sessionLease string
	childLease   string
}

func authFiles() (authFileSet, error) {
	claudePath, clxPath, err := authPaths()
	if err != nil {
		return authFileSet{}, err
	}
	stateDir := filepath.Dir(clxPath)
	return authFileSet{
		claude:       claudePath,
		clx:          clxPath,
		generation:   filepath.Join(stateDir, generationStateFile),
		logout:       filepath.Join(stateDir, "logout-intent.json"),
		purgeRequest: filepath.Join(stateDir, "purge-on-last-exit"),
		lock:         filepath.Join(stateDir, "auth.lock"),
		sessionLease: filepath.Join(filepath.Dir(claudePath), ".clx-auth-sessions.lock"),
		childLease:   filepath.Join(filepath.Dir(claudePath), ".clx-auth-active-child.lock"),
	}, nil
}

func lockAuthFiles() (authFileSet, func(), error) {
	paths, err := authFiles()
	if err != nil {
		return authFileSet{}, nil, err
	}
	if err := os.MkdirAll(filepath.Dir(paths.lock), 0o700); err != nil {
		return authFileSet{}, nil, err
	}
	f, err := os.OpenFile(paths.lock, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return authFileSet{}, nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		_ = f.Close()
		return authFileSet{}, nil, err
	}
	return paths, func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

func readGenerationState(path string) generationState {
	raw, err := os.ReadFile(path)
	if err != nil {
		return generationState{}
	}
	var state generationState
	if json.Unmarshal(raw, &state) != nil {
		return generationState{}
	}
	return state
}

// commitAuthPairLocked stages every file, commits the compatibility sidecar
// and generation metadata first, and commits the authoritative native file
// last. Once ~/.claude changes, both wrapper-owned companions are already in
// sync. A crash before the final rename can only leave ignored sidecar state.
func commitAuthPairLocked(paths authFileSet, native, state []byte, expected *AuthGeneration) (bool, error) {
	claudeTmp, err := stageFile(paths.claude, native, 0o600)
	if err != nil {
		return false, err
	}
	defer os.Remove(claudeTmp)
	stateTmp, err := stageFile(paths.generation, state, 0o600)
	if err != nil {
		return false, err
	}
	defer os.Remove(stateTmp)

	mirrorExists := false
	if _, err := os.Stat(paths.clx); err == nil {
		mirrorExists = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	var mirrorTmp string
	if mirrorExists {
		mirrorTmp, err = stageFile(paths.clx, native, 0o600)
		if err != nil {
			return false, err
		}
		defer os.Remove(mirrorTmp)
		if err := commitStaged(mirrorTmp, paths.clx); err != nil {
			return false, err
		}
	}
	if err := commitStaged(stateTmp, paths.generation); err != nil {
		return false, err
	}
	// Staging and fsync can take long enough for an upstream Claude process,
	// which cannot honor the wrapper lock, to mint a new login. Re-check at the
	// native commit point so that generation wins too; stale companion state is
	// harmless because readers bind it to the native digest.
	if expected != nil {
		current, err := generationAt(paths.claude)
		if err != nil {
			return false, err
		}
		if current != *expected {
			return false, nil
		}
	}
	if err := commitStaged(claudeTmp, paths.claude); err != nil {
		return false, err
	}
	return true, nil
}

func atomicWriteLocked(path string, body []byte, mode os.FileMode) error {
	tmp, err := stageFile(path, body, mode)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	return commitStaged(tmp, path)
}

func stageFile(path string, body []byte, mode os.FileMode) (string, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".*.new")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	ok := false
	defer func() {
		_ = tmp.Close()
		if !ok {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(mode); err != nil {
		return "", err
	}
	if _, err := tmp.Write(body); err != nil {
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	ok = true
	return tmpPath, nil
}

func commitStaged(tmpPath, path string) error {
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}

func syncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	err = f.Sync()
	// Some Unix filesystems/platforms do not support fsync on directory file
	// descriptors. The attempt still provides durability where supported; these
	// specific portability errors must not make every auth update fail on macOS.
	if errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ENOTSUP) {
		return nil
	}
	return err
}
