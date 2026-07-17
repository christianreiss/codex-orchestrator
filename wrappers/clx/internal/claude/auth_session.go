package claude

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

type logoutIntent struct {
	PreviousDigest        string `json:"previous_digest"`
	CreatedAt             string `json:"created_at"`
	Nonce                 string `json:"nonce,omitempty"`
	NativeRemovalDeferred bool   `json:"native_removal_deferred,omitempty"`
}

// LogoutIntentGeneration identifies the exact marker bytes observed beside an
// upload generation. It prevents a successful in-flight store from clearing a
// newer logout marker, even if the native credential digest stayed identical.
type LogoutIntentGeneration struct {
	Exists         bool
	Digest         string
	PreviousDigest string
}

// Blocks reports whether this marker still names the supplied native
// generation. A different usable generation is a pending login: it may be
// uploaded, but the marker remains until that exact upload is accepted.
func (g LogoutIntentGeneration) Blocks(s AuthSnapshot) bool {
	if !g.Exists {
		return false
	}
	if !s.Generation.Exists || !s.Usable || g.PreviousDigest == "" {
		return true
	}
	return s.Generation.Digest == g.PreviousDigest
}

type explicitLogoutGuard struct {
	before         AuthGeneration
	intent         LogoutIntentGeneration
	previousIntent []byte
	writer         *authChildLease
}

type purgeRequests struct {
	Requests map[string]string `json:"requests"`
}

// AuthSession holds a portable shared flock for one active CLX lifecycle. The
// lock is shared, so it never serializes interactive Claude sessions. On exit a
// process drops its share and tries a non-blocking exclusive conversion; only
// the last process can prove exclusivity and purge insecure-host credentials.
type AuthSession struct {
	mu        sync.Mutex
	f         *os.File
	id        string
	exclusive bool
}

var ErrAuthSessionsActive = errors.New("active CLX auth sessions prevent maintenance")
var ErrAuthMaintenanceActive = errors.New("CLX auth maintenance is active")

func StartAuthSession(purgeOnLastExit bool) (*AuthSession, error) {
	return startAuthSession(purgeOnLastExit, false)
}

// StartExplicitLogoutSession attempts to become the exclusive auth-session
// owner before wrapper-owned logout. If shared peers already exist it joins
// them and reports peers=true so the caller can journal deferred logout without
// starting a destructive child. If uninstall maintenance owns the exclusive
// lease, even the shared fallback fails and the command stops.
func StartExplicitLogoutSession(purgeOnLastExit bool) (*AuthSession, bool, error) {
	session, err := startAuthSession(purgeOnLastExit, true)
	if err == nil {
		return session, false, nil
	}
	if !errors.Is(err, ErrAuthSessionsActive) {
		return nil, false, err
	}
	session, err = StartAuthSession(purgeOnLastExit)
	if err != nil {
		return nil, false, err
	}
	return session, true, nil
}

func startAuthSession(purgeOnLastExit, exclusive bool) (*AuthSession, error) {
	paths, err := authFiles()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(paths.sessionLease), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(paths.sessionLease, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	mode := syscall.LOCK_SH | syscall.LOCK_NB
	if exclusive {
		mode = syscall.LOCK_EX | syscall.LOCK_NB
	}
	if err := syscall.Flock(int(f.Fd()), mode); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			if exclusive {
				return nil, ErrAuthSessionsActive
			}
			return nil, ErrAuthMaintenanceActive
		}
		return nil, err
	}
	id, err := newSessionID()
	if err != nil {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
		return nil, err
	}
	session := &AuthSession{f: f, id: id, exclusive: exclusive}
	if err := session.SetPurgeOnLastExit(purgeOnLastExit); err != nil {
		_ = session.Close()
		return nil, err
	}
	return session, nil
}

func newSessionID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// SetPurgeOnLastExit updates only this invocation's persisted purge request.
// Requests from earlier/concurrent insecure sessions remain sticky until the
// fleet's final shared session exits and performs the purge.
func (s *AuthSession) SetPurgeOnLastExit(enabled bool) error {
	if s == nil {
		return errors.New("nil Claude auth session")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f == nil || s.id == "" {
		return errors.New("Claude auth session already closed")
	}
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return err
	}
	defer unlock()
	state, err := readPurgeRequestsLocked(paths.purgeRequest)
	if err != nil {
		return err
	}
	if state.Requests == nil {
		state.Requests = map[string]string{}
	}
	if enabled {
		state.Requests[s.id] = time.Now().UTC().Format(time.RFC3339Nano)
	} else {
		delete(state.Requests, s.id)
	}
	return writePurgeRequestsLocked(paths.purgeRequest, state)
}

func readPurgeRequestsLocked(path string) (purgeRequests, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return purgeRequests{Requests: map[string]string{}}, nil
	}
	if err != nil {
		return purgeRequests{}, err
	}
	var state purgeRequests
	if err := json.Unmarshal(raw, &state); err != nil || state.Requests == nil {
		// A pre-generation marker is a real outstanding request. Preserve it
		// under a reserved id rather than letting a newer secure invocation
		// erase another process's insecure cleanup decision.
		return purgeRequests{Requests: map[string]string{"legacy": string(raw)}}, nil
	}
	return state, nil
}

func writePurgeRequestsLocked(path string, state purgeRequests) error {
	if len(state.Requests) == 0 {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return syncExistingDir(filepath.Dir(path))
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return atomicWriteLocked(path, raw, 0o600)
}

// CloseAndPurgeIfLast releases this process's shared lease, then purges auth
// only if it can prove that no other CLX lifecycle still holds a shared lease.
// It returns purged=false when another session remains active.
func (s *AuthSession) CloseAndPurgeIfLast() (purged bool, err error) {
	if s == nil {
		return false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f == nil {
		return false, nil
	}
	f := s.f
	s.f = nil
	defer f.Close()
	if !s.exclusive {
		if err := syscall.Flock(int(f.Fd()), syscall.LOCK_UN); err != nil {
			return false, err
		}
		if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
				return false, nil
			}
			return false, err
		}
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN) //nolint:errcheck
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return false, err
	}
	defer unlock()
	childLease, err := tryAcquireAuthChildWriter()
	if err != nil {
		return false, err
	}
	defer childLease.Close() //nolint:errcheck
	if err := completeDeferredLogoutLocked(paths); err != nil {
		return false, err
	}
	requests, err := readPurgeRequestsLocked(paths.purgeRequest)
	if err != nil {
		return false, err
	}
	if len(requests.Requests) == 0 {
		return false, nil
	}
	if err := purgeAuthLocked(paths); err != nil {
		return false, err
	}
	return true, nil
}

// FinalizeForReexec closes the current process's session before syscall.Exec.
// Go defers do not run across exec, so callers must invoke this explicitly or
// leave an orphaned per-session purge request behind. Close is idempotent; the
// lifecycle's ordinary deferred cleanup becomes a no-op after this succeeds.
func (s *AuthSession) FinalizeForReexec() error {
	_, err := s.CloseAndPurgeIfLast()
	return err
}

// Close releases a session lease without deleting credentials. Standalone
// login/logout commands use it to participate in last-session detection while
// leaving purge policy to their caller.
func (s *AuthSession) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f == nil {
		return nil
	}
	f := s.f
	s.f = nil
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return f.Close()
}

func purgeAuthLocked(paths authFileSet) error {
	// Native auth is the commit point and is removed last. If cleanup is
	// interrupted earlier, Claude still has its authoritative file; if removal
	// reaches the native file, no ignored sidecar can resurrect it.
	for _, path := range []string{paths.clx, paths.generation, paths.claude, paths.purgeRequest} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove %s: %w", path, err)
		}
		if err := syncExistingDir(filepath.Dir(path)); err != nil {
			return err
		}
	}
	return nil
}

// AuthMaintenance is an exclusive lease used by uninstall. The lease file is
// outside ~/.clx so deleting the wrapper state cannot create a second lock inode
// that would let a new CLX process race the destructive operation.
type AuthMaintenance struct {
	f          *os.File
	childLease *authChildLease
}

func AcquireAuthMaintenance() (*AuthMaintenance, error) {
	paths, err := authFiles()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(paths.sessionLease), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(paths.sessionLease, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, ErrAuthSessionsActive
		}
		return nil, err
	}
	childLease, err := tryAcquireAuthChildWriter()
	if err != nil {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
		return nil, err
	}
	return &AuthMaintenance{f: f, childLease: childLease}, nil
}

func (m *AuthMaintenance) Close() error {
	if m == nil || m.f == nil {
		return nil
	}
	f := m.f
	childLease := m.childLease
	m.f = nil
	m.childLease = nil
	if childLease != nil {
		_ = childLease.Close()
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return f.Close()
}

func syncExistingDir(dir string) error {
	if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return syncDir(dir)
}

// MarkLogoutIfCurrent records an intentional logout only when the native file
// is now missing or structurally unusable and the caller observed the supplied
// generation before launching Claude. A newer usable login is preserved, but
// any pre-existing intent remains until the server accepts that generation.
func MarkLogoutIfCurrent(before AuthGeneration) (bool, error) {
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return false, err
	}
	defer unlock()
	current, err := generationAt(paths.claude)
	if err != nil {
		return false, err
	}
	if current.Exists {
		raw, err := os.ReadFile(paths.claude)
		if err != nil {
			return false, err
		}
		if isUsableAuth(raw) {
			if current != before {
				return false, nil
			}
			return false, nil
		}
	}
	if current == before {
		return false, nil
	}
	return recordLogoutIntentLocked(paths, before, false)
}

// RecordExplicitLogout persists a successful user-requested logout even when
// Claude started and ended with no native credential file. That distinction is
// unknowable during an ordinary interactive session, but explicit `logout`
// must not let a later bootstrap silently re-materialize the fleet copy. A
// concurrently written, different usable login is preserved for upload.
func RecordExplicitLogout(before AuthGeneration) (bool, error) {
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return false, err
	}
	defer unlock()
	current, err := generationAt(paths.claude)
	if err != nil {
		return false, err
	}
	markerGeneration := before
	if current.Exists {
		markerGeneration = current
		raw, err := os.ReadFile(paths.claude)
		if err != nil {
			return false, err
		}
		// Ordering rule: a different usable generation completed after this
		// logout command's pre-child snapshot, so preserve it for a later
		// server-acknowledged upload. When the generation is unchanged, logout
		// wins and is recorded even if a peer child forces removal deferral.
		if isUsableAuth(raw) && current != before {
			return false, nil
		}
	}
	childLease, childErr := tryAcquireAuthChildWriter()
	if childErr != nil && !errors.Is(childErr, ErrAuthChildActive) {
		return false, childErr
	}
	if childLease != nil {
		defer childLease.Close() //nolint:errcheck
	}
	// Journal intent before native removal. A crash or marker-write failure can
	// therefore never turn an explicit logout into a later canonical restore.
	marked, err := recordLogoutIntentLocked(paths, markerGeneration, current.Exists)
	if err != nil || !marked {
		return marked, err
	}
	if childLease == nil || !current.Exists {
		return true, nil
	}
	if err := removeNativeAuthLocked(paths); err != nil {
		return false, err
	}
	return true, nil
}

// RecordDeferredExplicitLogout journals logout without touching the native
// credential file. It is used when another wrapper auth session exists but has
// not necessarily started its Claude child yet; that peer may already have
// selected the current generation. Final-session cleanup performs removal.
func RecordDeferredExplicitLogout(before AuthGeneration) (bool, error) {
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return false, err
	}
	defer unlock()
	current, err := generationAt(paths.claude)
	if err != nil {
		return false, err
	}
	markerGeneration := before
	if current.Exists {
		markerGeneration = current
		raw, err := os.ReadFile(paths.claude)
		if err != nil {
			return false, err
		}
		if isUsableAuth(raw) && current != before {
			return false, nil
		}
	}
	return recordLogoutIntentLocked(paths, markerGeneration, current.Exists)
}

// beginExplicitLogout journals wrapper-owned logout before starting the
// destructive upstream command and holds the child-writer lease across it. If a
// peer child is active, intent is recorded and the upstream command is skipped;
// final-session cleanup performs native removal after the peer exits.
func beginExplicitLogout(before AuthGeneration) (guard *explicitLogoutGuard, deferred, marked bool, err error) {
	writer, err := tryAcquireAuthChildWriter()
	if errors.Is(err, ErrAuthChildActive) {
		marked, err := RecordExplicitLogout(before)
		return nil, true, marked, err
	}
	if err != nil {
		return nil, false, false, err
	}

	paths, unlock, err := lockAuthFiles()
	if err != nil {
		_ = writer.Close()
		return nil, false, false, err
	}
	defer unlock()
	current, err := generationAt(paths.claude)
	if err != nil {
		_ = writer.Close()
		return nil, false, false, err
	}
	markerGeneration := before
	previousIntent, previousErr := os.ReadFile(paths.logout)
	if previousErr != nil && !errors.Is(previousErr, os.ErrNotExist) {
		_ = writer.Close()
		return nil, false, false, previousErr
	}
	if current.Exists {
		markerGeneration = current
		raw, readErr := os.ReadFile(paths.claude)
		if readErr != nil {
			_ = writer.Close()
			return nil, false, false, readErr
		}
		if isUsableAuth(raw) && current != before {
			_ = writer.Close()
			return nil, false, false, nil
		}
	}
	marked, err = recordLogoutIntentLocked(paths, markerGeneration, current.Exists)
	if err != nil || !marked {
		_ = writer.Close()
		return nil, false, marked, err
	}
	intent, err := logoutIntentGenerationAt(paths.logout)
	if err != nil {
		_ = writer.Close()
		return nil, false, false, err
	}
	return &explicitLogoutGuard{before: markerGeneration, intent: intent, previousIntent: previousIntent, writer: writer}, false, true, nil
}

func (g *explicitLogoutGuard) finish(success bool) (marked bool, err error) {
	if g == nil {
		return false, nil
	}
	defer func() {
		err = errors.Join(err, g.writer.Close())
	}()
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return false, err
	}
	defer unlock()
	current, err := generationAt(paths.claude)
	if err != nil {
		return false, err
	}
	if current.Exists {
		raw, readErr := os.ReadFile(paths.claude)
		if readErr != nil {
			return false, readErr
		}
		if isUsableAuth(raw) && current != g.before {
			return true, nil
		}
		if !success && isUsableAuth(raw) && current == g.before {
			return false, restoreLogoutIntentIfGenerationLocked(paths, g.intent, g.previousIntent)
		}
	}
	if !success {
		// A non-zero upstream command that nevertheless removed or invalidated the
		// native file must retain intent; otherwise the next bootstrap resurrects
		// credentials after a partially successful logout.
		return true, nil
	}
	if current.Exists {
		if err := removeNativeAuthLocked(paths); err != nil {
			return true, err
		}
	}
	return true, nil
}

func clearLogoutIntentIfGenerationLocked(paths authFileSet, expected LogoutIntentGeneration) error {
	current, err := logoutIntentGenerationAt(paths.logout)
	if err != nil {
		return err
	}
	if current != expected {
		return nil
	}
	return clearLogoutIntentLocked(paths)
}

func restoreLogoutIntentIfGenerationLocked(paths authFileSet, expected LogoutIntentGeneration, previous []byte) error {
	current, err := logoutIntentGenerationAt(paths.logout)
	if err != nil {
		return err
	}
	if current != expected {
		return nil
	}
	if len(previous) == 0 {
		return clearLogoutIntentLocked(paths)
	}
	return atomicWriteLocked(paths.logout, previous, 0o600)
}

func recordLogoutIntentLocked(paths authFileSet, before AuthGeneration, nativeRemovalDeferred bool) (bool, error) {
	nonce, err := newSessionID()
	if err != nil {
		return false, err
	}
	marker, err := json.Marshal(logoutIntent{
		PreviousDigest:        before.Digest,
		CreatedAt:             time.Now().UTC().Format(time.RFC3339Nano),
		Nonce:                 nonce,
		NativeRemovalDeferred: nativeRemovalDeferred,
	})
	if err != nil {
		return false, err
	}
	if err := atomicWriteLocked(paths.logout, marker, 0o600); err != nil {
		return false, err
	}
	// Compatibility state must never outlive an intentional native logout.
	for _, path := range []string{paths.clx, paths.generation} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return false, err
		}
		if err := syncExistingDir(filepath.Dir(path)); err != nil {
			return false, err
		}
	}
	return true, nil
}

func LogoutIntentActive() (bool, error) {
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return false, err
	}
	defer unlock()
	current, err := generationAt(paths.claude)
	if err != nil {
		return false, err
	}
	return logoutIntentActiveLocked(paths, current)
}

// CurrentLogoutIntentGeneration snapshots the exact marker contents without
// interpreting them. Explicit login/upload uses this alongside the auth
// generation for a post-store compare-and-swap.
func CurrentLogoutIntentGeneration() (LogoutIntentGeneration, error) {
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return LogoutIntentGeneration{}, err
	}
	defer unlock()
	return logoutIntentGenerationAt(paths.logout)
}

// ClearLogoutIntentIfUnchanged acknowledges an accepted explicit login/upload
// only when both native auth and marker bytes are exactly what the request saw.
// A concurrently replaced same-generation marker therefore survives.
func ClearLogoutIntentIfUnchanged(expected AuthGeneration, expectedIntent LogoutIntentGeneration) (bool, error) {
	paths, unlock, err := lockAuthFiles()
	if err != nil {
		return false, err
	}
	defer unlock()
	current, err := generationAt(paths.claude)
	if err != nil {
		return false, err
	}
	if current != expected {
		return false, nil
	}
	currentIntent, err := logoutIntentGenerationAt(paths.logout)
	if err != nil {
		return false, err
	}
	if currentIntent != expectedIntent {
		return false, nil
	}
	if currentIntent.Exists {
		if err := clearLogoutIntentLocked(paths); err != nil {
			return false, err
		}
	}
	return true, nil
}

func logoutIntentGenerationAt(path string) (LogoutIntentGeneration, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return LogoutIntentGeneration{}, nil
	}
	if err != nil {
		return LogoutIntentGeneration{}, err
	}
	var marker logoutIntent
	_ = json.Unmarshal(raw, &marker)
	return LogoutIntentGeneration{Exists: true, Digest: digestBytes(raw), PreviousDigest: marker.PreviousDigest}, nil
}

func HasLogoutIntent() bool {
	active, err := LogoutIntentActive()
	return err != nil || active
}

func logoutIntentActiveLocked(paths authFileSet, current AuthGeneration) (bool, error) {
	raw, err := os.ReadFile(paths.logout)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var marker logoutIntent
	if err := json.Unmarshal(raw, &marker); err != nil {
		return true, fmt.Errorf("parse Claude logout intent: %w", err)
	}
	if !current.Exists {
		return true, nil
	}
	native, err := os.ReadFile(paths.claude)
	if err != nil || !isUsableAuth(native) {
		return true, err
	}
	if current.Digest != marker.PreviousDigest {
		return true, nil
	}
	// An explicit logout recorded while another Claude child was using this
	// exact generation leaves native removal deferred. Complete it once the
	// active-child lease proves no wrapped child can observe the rename.
	if marker.NativeRemovalDeferred {
		childLease, childErr := tryAcquireAuthChildWriter()
		if childErr == nil {
			defer childLease.Close() //nolint:errcheck
			if err := os.Remove(paths.claude); err != nil && !errors.Is(err, os.ErrNotExist) {
				return true, err
			}
			if err := syncExistingDir(filepath.Dir(paths.claude)); err != nil {
				return true, err
			}
		} else if !errors.Is(childErr, ErrAuthChildActive) {
			return true, childErr
		}
	}
	return true, nil
}

// completeDeferredLogoutLocked runs while both the short auth lock and the
// active-child writer lease are held. It services durable logout intent on the
// final wrapped-session exit even for secure hosts, where no insecure purge
// request exists to otherwise trigger credential removal.
func completeDeferredLogoutLocked(paths authFileSet) error {
	raw, err := os.ReadFile(paths.logout)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var marker logoutIntent
	if err := json.Unmarshal(raw, &marker); err != nil {
		return fmt.Errorf("parse Claude logout intent: %w", err)
	}
	current, err := generationAt(paths.claude)
	if err != nil {
		return err
	}
	if !current.Exists {
		return nil
	}
	native, err := os.ReadFile(paths.claude)
	if err != nil {
		return err
	}
	if isUsableAuth(native) && current.Digest != marker.PreviousDigest {
		return nil
	}
	// Same-generation auth remains governed by explicit logout, including old
	// markers written before NativeRemovalDeferred existed. A distinct usable
	// login is preserved, but only a server-accepted upload clears the marker.
	return removeNativeAuthLocked(paths)
}

func removeNativeAuthLocked(paths authFileSet) error {
	if err := os.Remove(paths.claude); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncExistingDir(filepath.Dir(paths.claude))
}

func clearLogoutIntentLocked(paths authFileSet) error {
	if err := os.Remove(paths.logout); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncExistingDir(filepath.Dir(paths.logout))
}
