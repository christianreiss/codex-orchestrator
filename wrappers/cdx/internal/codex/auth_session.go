package codex

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ipc"
)

const (
	authSessionLeaseFile  = ".cdx-auth-sessions.lock"
	activeChildLeaseFile  = ".cdx-active-children.lock"
	authPurgeRequestFile  = ".cdx-insecure-purge-request"
	authSessionHandoffEnv = "CDX_AUTH_SESSION_HANDOFF"
)

var errAuthSessionClosed = errors.New("Codex auth session already closed")

type purgeRequests struct {
	Requests map[string]string `json:"requests"`
}

type authSessionHandoff struct {
	Home     string   `json:"home"`
	IDs      []string `json:"ids"`
	BridgeFD int      `json:"bridge_fd"`
}

// AuthSession is one home-keyed shared lifecycle lease plus a unique purge
// request identity. Per-session identities let a process revise its own stale
// secure/insecure observation without erasing a concurrent process's request.
type AuthSession struct {
	mu    sync.Mutex
	lease *ipc.Lock
	home  string
	id    string
}

var activeAuthSessions = struct {
	sync.Mutex
	byHome  map[string]map[*AuthSession]struct{}
	desired map[string]bool
	reexec  bool
}{
	byHome:  make(map[string]map[*AuthSession]struct{}),
	desired: make(map[string]bool),
}

func authStatePathForHome(home, name string) string {
	return filepath.Join(home, name)
}

func authStatePath(name string) (string, error) {
	home, err := CodexHome()
	if err != nil {
		return "", err
	}
	return authStatePathForHome(home, name), nil
}

// AcquireAuthSession records one wrapper process that may read, write, or use
// the shared local Codex credential. Call FinishAuthSession exactly once.
func AcquireAuthSession() (*AuthSession, error) {
	home, err := CodexHome()
	if err != nil {
		return nil, err
	}
	lease, err := ipc.TryAcquireSharedPath(authStatePathForHome(home, authSessionLeaseFile))
	if err != nil {
		if errors.Is(err, ipc.ErrHeld) {
			return nil, fmt.Errorf("Codex auth maintenance is active: %w", err)
		}
		return nil, err
	}
	rawID := make([]byte, 16)
	if _, err := rand.Read(rawID); err != nil {
		_ = lease.Release()
		return nil, fmt.Errorf("generate auth session id: %w", err)
	}
	session := &AuthSession{lease: lease, home: home, id: hex.EncodeToString(rawID)}
	activeAuthSessions.Lock()
	if activeAuthSessions.reexec {
		activeAuthSessions.Unlock()
		_ = lease.Release()
		return nil, errors.New("auth session re-exec handoff is in progress")
	}
	set := activeAuthSessions.byHome[home]
	if set == nil {
		set = make(map[*AuthSession]struct{})
		activeAuthSessions.byHome[home] = set
	}
	set[session] = struct{}{}
	desired, hasDesired := activeAuthSessions.desired[home]
	activeAuthSessions.Unlock()
	if hasDesired {
		if err := session.SetPurgeOnLastExit(desired); err != nil {
			_ = closeAuthSessionLease(session)
			return nil, err
		}
	}
	return session, nil
}

// StartAuthSession acquires a session and records its initial baked/config
// security observation. Live API responses should update all sessions in this
// process through SetActiveAuthSessionsPurgeOnLastExit.
func StartAuthSession(purgeOnLastExit bool) (*AuthSession, error) {
	session, err := AcquireAuthSession()
	if err != nil {
		return nil, err
	}
	activeAuthSessions.Lock()
	desired, exists := activeAuthSessions.desired[session.home]
	if !exists {
		desired = purgeOnLastExit
		activeAuthSessions.desired[session.home] = desired
	}
	activeAuthSessions.Unlock()
	if err := session.SetPurgeOnLastExit(desired); err != nil {
		_ = closeAuthSessionLease(session)
		return nil, err
	}
	return session, nil
}

// PrepareAuthSessionReexec adds a durable session handoff to env without
// changing the current process's purge requests. It also duplicates one live
// shared lease into a non-CLOEXEC bridge. The returned cancel function must be
// deferred by the syscall.Exec caller: it runs only when Exec fails, closes
// the bridge, and re-enables new sessions in the original process.
func PrepareAuthSessionReexec(env []string) ([]string, func() error, error) {
	home, err := CodexHome()
	if err != nil {
		return nil, nil, err
	}
	activeAuthSessions.Lock()
	if activeAuthSessions.reexec {
		activeAuthSessions.Unlock()
		return nil, nil, errors.New("auth session re-exec handoff already prepared")
	}
	activeAuthSessions.reexec = true
	set := activeAuthSessions.byHome[home]
	sessions := make([]*AuthSession, 0, len(set))
	for session := range set {
		sessions = append(sessions, session)
	}
	activeAuthSessions.Unlock()

	ids := make([]string, 0, len(sessions))
	var bridge *ipc.ExecLease
	for _, session := range sessions {
		session.mu.Lock()
		if session.lease != nil && session.home == home && session.id != "" {
			if bridge == nil {
				bridge, err = session.lease.DuplicateForExec()
			}
			if err == nil {
				ids = append(ids, session.id)
			}
		}
		session.mu.Unlock()
		if err != nil {
			break
		}
	}
	cancel := func() error {
		var closeErr error
		if bridge != nil {
			closeErr = bridge.Release()
		}
		activeAuthSessions.Lock()
		activeAuthSessions.reexec = false
		activeAuthSessions.Unlock()
		return closeErr
	}
	if err != nil {
		_ = cancel()
		return nil, nil, fmt.Errorf("duplicate auth session lease for re-exec: %w", err)
	}
	if len(ids) == 0 {
		_ = cancel()
		return append([]string(nil), env...), func() error { return nil }, nil
	}
	raw, err := json.Marshal(authSessionHandoff{Home: home, IDs: ids, BridgeFD: int(bridge.FD())})
	if err != nil {
		_ = cancel()
		return nil, nil, fmt.Errorf("encode auth session handoff: %w", err)
	}
	value := base64.RawURLEncoding.EncodeToString(raw)
	out := append([]string(nil), env...)
	prefix := authSessionHandoffEnv + "="
	for i, entry := range out {
		if len(entry) >= len(prefix) && entry[:len(prefix)] == prefix {
			out[i] = prefix + value
			return out, cancel, nil
		}
	}
	return append(out, prefix+value), cancel, nil
}

// ResumeAuthSessionReexecHandoff is called before any normal command dispatch.
// It returns nil when this is not a post-update exec. When a handoff is
// present, the returned session must be finished even if config loading or
// argument validation fails, so an insecure purge cannot be stranded between
// wrapper generations.
func ResumeAuthSessionReexecHandoff() (*AuthSession, error) {
	encoded, ok := os.LookupEnv(authSessionHandoffEnv)
	if !ok {
		return nil, nil
	}
	if err := os.Unsetenv(authSessionHandoffEnv); err != nil {
		return nil, fmt.Errorf("clear auth session handoff environment: %w", err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("decode auth session handoff: %w", err)
	}
	var handoff authSessionHandoff
	if err := json.Unmarshal(raw, &handoff); err != nil {
		return nil, fmt.Errorf("parse auth session handoff: %w", err)
	}
	if handoff.Home == "" || len(handoff.IDs) == 0 || handoff.BridgeFD < 3 {
		return nil, errors.New("invalid empty auth session handoff")
	}
	home, err := CodexHome()
	if err != nil {
		return nil, err
	}
	if handoff.Home != home {
		return nil, fmt.Errorf("auth session handoff home mismatch: got %q, want %q", handoff.Home, home)
	}
	bridge, err := ipc.AdoptInheritedPath(uintptr(handoff.BridgeFD), authStatePathForHome(home, authSessionLeaseFile))
	if err != nil {
		return nil, fmt.Errorf("adopt auth session re-exec bridge: %w", err)
	}

	session, err := AcquireAuthSession()
	if err != nil {
		_ = bridge.Release()
		return nil, err
	}
	requested, err := adoptAuthSessionHandoff(session, handoff.IDs)
	if err != nil {
		_ = closeAuthSessionLease(session)
		_ = bridge.Release()
		return nil, fmt.Errorf("adopt auth session handoff: %w", err)
	}
	if requested {
		activeAuthSessions.Lock()
		activeAuthSessions.desired[home] = true
		activeAuthSessions.Unlock()
	}
	if err := bridge.Release(); err != nil {
		_ = closeAuthSessionLease(session)
		return nil, fmt.Errorf("release auth session re-exec bridge: %w", err)
	}
	return session, nil
}

func adoptAuthSessionHandoff(session *AuthSession, oldIDs []string) (bool, error) {
	if session == nil {
		return false, errors.New("nil Codex auth session")
	}
	session.mu.Lock()
	if session.lease == nil || session.id == "" {
		session.mu.Unlock()
		return false, errAuthSessionClosed
	}
	home, id := session.home, session.id
	session.mu.Unlock()

	old := make(map[string]struct{}, len(oldIDs))
	for _, oldID := range oldIDs {
		if oldID == "" {
			return false, errors.New("auth session handoff contains an empty id")
		}
		old[oldID] = struct{}{}
	}
	requested := false
	authPath := filepath.Join(home, "auth.json")
	err := withAuthLockAt(authPath, func(string) error {
		path := authStatePathForHome(home, authPurgeRequestFile)
		state, err := readPurgeRequests(path)
		if err != nil {
			return err
		}
		for oldID := range old {
			if _, exists := state.Requests[oldID]; exists {
				requested = true
			}
		}
		if requested {
			state.Requests[id] = time.Now().UTC().Format(time.RFC3339Nano)
		}
		for oldID := range old {
			delete(state.Requests, oldID)
		}
		return writePurgeRequests(path, state)
	})
	return requested, err
}

// SetPurgeOnLastExit revises only this session's persisted request.
func (s *AuthSession) SetPurgeOnLastExit(enabled bool) error {
	if s == nil {
		return errors.New("nil Codex auth session")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lease == nil || s.id == "" {
		return errAuthSessionClosed
	}
	return updatePurgeRequest(s.home, s.id, enabled)
}

// SetActiveAuthSessionsPurgeOnLastExit applies one live host-security
// observation to every nested session in this process and this Codex home.
// Other processes have different persisted IDs and remain untouched.
func SetActiveAuthSessionsPurgeOnLastExit(enabled bool) error {
	home, err := CodexHome()
	if err != nil {
		return err
	}
	activeAuthSessions.Lock()
	set := activeAuthSessions.byHome[home]
	if len(set) > 0 {
		activeAuthSessions.desired[home] = enabled
	}
	sessions := make([]*AuthSession, 0, len(set))
	for session := range set {
		sessions = append(sessions, session)
	}
	activeAuthSessions.Unlock()
	var joined error
	for _, session := range sessions {
		if err := session.SetPurgeOnLastExit(enabled); err != nil && !errors.Is(err, errAuthSessionClosed) {
			joined = errors.Join(joined, err)
		}
	}
	return joined
}

// UpdateActiveAuthSessionSecurity records the freshest authoritative security
// observation returned by the API. Some approval responses intentionally omit
// the host block; their insecure status is still authoritative and must not be
// mistaken for the secure value baked into an older wrapper config.
func UpdateActiveAuthSessionSecurity(status string, hostSecure *bool) error {
	if hostSecure != nil {
		return SetActiveAuthSessionsPurgeOnLastExit(!*hostSecure)
	}
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "insecure", "insecure-denied":
		return SetActiveAuthSessionsPurgeOnLastExit(true)
	default:
		return nil
	}
}

func updatePurgeRequest(home, id string, enabled bool) error {
	authPath := filepath.Join(home, "auth.json")
	return withAuthLockAt(authPath, func(string) error {
		path := authStatePathForHome(home, authPurgeRequestFile)
		state, err := readPurgeRequests(path)
		if err != nil {
			return err
		}
		if enabled {
			state.Requests[id] = time.Now().UTC().Format(time.RFC3339Nano)
		} else {
			delete(state.Requests, id)
		}
		return writePurgeRequests(path, state)
	})
}

func readPurgeRequests(path string) (purgeRequests, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return purgeRequests{Requests: make(map[string]string)}, nil
	}
	if err != nil {
		return purgeRequests{}, err
	}
	var state purgeRequests
	if err := json.Unmarshal(raw, &state); err != nil || state.Requests == nil {
		// Preserve the old boolean marker as a real outstanding request.
		return purgeRequests{Requests: map[string]string{"legacy": string(raw)}}, nil
	}
	return state, nil
}

func writePurgeRequests(path string, state purgeRequests) error {
	if len(state.Requests) == 0 {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return syncDirectory(filepath.Dir(path))
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return atomicWriteFile(path, raw, 0o600)
}

// TryAcquireAuthMaintenance proves no cdx process targeting this Codex home is
// still active. Uninstall holds the returned exclusive lease across every
// remote and local mutation.
func TryAcquireAuthMaintenance() (*ipc.Lock, error) {
	path, err := authStatePath(authSessionLeaseFile)
	if err != nil {
		return nil, err
	}
	return ipc.TryAcquireExclusivePath(path)
}

// AcquireActiveChild records the interval in which an upstream Codex process
// can rotate auth.json without participating in the wrapper's auth-file lock.
func AcquireActiveChild() (*ipc.Lock, error) {
	path, err := authStatePath(activeChildLeaseFile)
	if err != nil {
		return nil, err
	}
	return ipc.AcquireSharedPath(path)
}

// AttachAuthLeaseFiles passes duplicate session/child descriptors into an
// upstream process. flock ownership then survives SIGKILL of the wrapper: an
// orphaned native Codex process remains visible to uninstall/logout and to
// canonical writers until that child actually exits.
//
// The returned function closes only the parent's duplicate descriptors and is
// safe to call more than once. Call it immediately after cmd.Start (or on a
// failed Start); the child has its own descriptor copies by then.
func AttachAuthLeaseFiles(cmd *exec.Cmd, session *AuthSession, leases ...*ipc.Lock) (func() error, error) {
	if cmd == nil {
		return func() error { return nil }, errors.New("nil Codex child command")
	}
	var (
		extras []*ipc.ExecLease
		once   sync.Once
		joined error
	)
	closeExtras := func() error {
		once.Do(func() {
			for _, extra := range extras {
				joined = errors.Join(joined, extra.Release())
			}
		})
		return joined
	}
	duplicate := func(lease *ipc.Lock) error {
		if lease == nil {
			return errors.New("Codex auth child lease is nil")
		}
		extra, err := lease.DuplicateForExec()
		if err != nil {
			return err
		}
		extras = append(extras, extra)
		cmd.ExtraFiles = append(cmd.ExtraFiles, extra.File())
		return nil
	}
	if session != nil {
		session.mu.Lock()
		if session.lease == nil {
			session.mu.Unlock()
			return closeExtras, errAuthSessionClosed
		}
		err := duplicate(session.lease)
		session.mu.Unlock()
		if err != nil {
			_ = closeExtras()
			return closeExtras, fmt.Errorf("duplicate Codex auth session lease: %w", err)
		}
	}
	for _, lease := range leases {
		if err := duplicate(lease); err != nil {
			_ = closeExtras()
			return closeExtras, fmt.Errorf("duplicate Codex auth child lease: %w", err)
		}
	}
	return closeExtras, nil
}

func tryAcquireAuthWriter() (*ipc.Lock, error) {
	home, err := CodexHome()
	if err != nil {
		return nil, err
	}
	return tryAcquireAuthWriterAt(home)
}

func tryAcquireAuthWriterAt(home string) (*ipc.Lock, error) {
	return ipc.TryAcquireExclusivePath(authStatePathForHome(home, activeChildLeaseFile))
}

func closeAuthSessionLease(session *AuthSession) error {
	if session == nil {
		return nil
	}
	session.mu.Lock()
	lease := session.lease
	session.lease = nil
	home := session.home
	session.mu.Unlock()
	activeAuthSessions.Lock()
	delete(activeAuthSessions.byHome[home], session)
	if len(activeAuthSessions.byHome[home]) == 0 {
		delete(activeAuthSessions.byHome, home)
		delete(activeAuthSessions.desired, home)
	}
	activeAuthSessions.Unlock()
	if lease == nil {
		return nil
	}
	return lease.Release()
}

// FinishAuthSession releases this process's shared lease and services durable
// insecure-purge and explicit-logout intent only after a non-blocking exclusive
// lease proves no other wrapper session remains. Logout is checked even for a
// secure host, so a deferred explicit logout cannot be stranded indefinitely.
func FinishAuthSession(session *AuthSession) (removed, deferred bool, err error) {
	if session == nil {
		return false, false, nil
	}
	home := session.home
	if err := closeAuthSessionLease(session); err != nil {
		return false, false, fmt.Errorf("release auth session lease: %w", err)
	}
	requestPath := authStatePathForHome(home, authPurgeRequestFile)
	var (
		requests purgeRequests
		intent   LogoutIntentGeneration
	)
	if err := withAuthLockAt(filepath.Join(home, "auth.json"), func(string) error {
		var readErr error
		requests, readErr = readPurgeRequests(requestPath)
		if readErr != nil {
			return readErr
		}
		intent, readErr = logoutIntentGenerationAt(filepath.Join(home, "auth.json"))
		return readErr
	}); err != nil {
		return false, false, fmt.Errorf("read pending auth cleanup state: %w", err)
	}
	if len(requests.Requests) == 0 && !intent.Exists {
		return false, false, nil
	}
	cleanup, err := ipc.TryAcquireExclusivePath(authStatePathForHome(home, authSessionLeaseFile))
	if err != nil {
		if errors.Is(err, ipc.ErrHeld) {
			return false, true, nil
		}
		return false, false, fmt.Errorf("acquire exclusive auth cleanup lease: %w", err)
	}
	defer func() {
		err = errors.Join(err, cleanup.Release())
	}()
	writer, err := tryAcquireAuthWriterAt(home)
	if err != nil {
		if errors.Is(err, ipc.ErrHeld) {
			return false, true, nil
		}
		return false, false, fmt.Errorf("acquire auth cleanup writer lease: %w", err)
	}
	defer func() {
		err = errors.Join(err, writer.Release())
	}()
	authPath := filepath.Join(home, "auth.json")
	if err := withAuthLockAt(authPath, func(string) error {
		currentIntent, readErr := logoutIntentGenerationAt(authPath)
		if readErr != nil {
			return readErr
		}
		if currentIntent.Exists {
			logoutRemoved, completeErr := completeDeferredLogoutLocked(authPath)
			removed = removed || logoutRemoved
			if completeErr != nil {
				return completeErr
			}
		}
		requests, readErr = readPurgeRequests(requestPath)
		if readErr != nil {
			return readErr
		}
		if len(requests.Requests) == 0 {
			return nil
		}
		generation, generationErr := authGenerationAt(authPath)
		if generationErr != nil {
			return generationErr
		}
		if generation.Exists {
			if removeErr := os.Remove(authPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				return removeErr
			}
			if syncErr := syncDirectory(filepath.Dir(authPath)); syncErr != nil {
				return syncErr
			}
			removed = true
		}
		return writePurgeRequests(requestPath, purgeRequests{Requests: make(map[string]string)})
	}); err != nil {
		return removed, false, fmt.Errorf("complete pending auth cleanup: %w", err)
	}
	return removed, false, nil
}
