package communicator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

// Fence protects the existing interactive/login/finalization transactions from
// finite background workers, including across a communicator crash. It is never
// held for a native session's lifetime.
func Fence(ctx context.Context, base, engine, authPath string) (func(), error) {
	if endpointFor(base) == nil || os.Getenv("CXX_COMMUNICATOR_SYNC") == "1" {
		return func() {}, nil
	}
	job, err := newSyncJob(ctx, base, engine, authPath)
	if err != nil {
		return nil, err
	}
	ep := endpointFor(base)
	ep.mu.Lock()
	setupErr := ep.setupErr
	ep.mu.Unlock()
	if setupErr != nil {
		return nil, setupErr
	}
	for {
		lock, err := ipc.TryAcquireExclusivePath(filepath.Join(filepath.Dir(ep.localSocket()), "sync-"+scopeID(job)+".lock"))
		if err == nil {
			return func() { _ = lock.Release() }, nil
		}
		if !errors.Is(err, ipc.ErrHeld) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

// RecoveryFence also protects an explicit reconciliation after a signed rollback
// disabled managed sync. Its scope is exactly the worker's engine/native-home.
// Automatic uploads use it too, even when no transport endpoint is configured.
func RecoveryFence(ctx context.Context, base, engine, authPath string) (func(), error) {
	if engine != "codex" && engine != "claude" {
		return nil, errors.New("explicit credential recovery supports Codex and Claude only")
	}
	socket, err := socketPath(base)
	if err != nil {
		return nil, err
	}
	raw := engine + "\x00" + canonicalPath(filepath.Dir(authPath))
	sum := sha256.Sum256([]byte(raw))
	lockPath := filepath.Join(filepath.Dir(socket), "sync-"+hex.EncodeToString(sum[:])+".lock")
	for {
		lock, err := ipc.TryAcquireExclusivePath(lockPath)
		if err == nil {
			return func() { _ = lock.Release() }, nil
		}
		if !errors.Is(err, ipc.ErrHeld) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

// AutomaticAuthFence shares explicit recovery's scope on both managed and
// rolled-back transport. A worker subprocess already holds that scope in its
// parent owner, so it must not acquire the same exclusive lock recursively.
func AutomaticAuthFence(ctx context.Context, base, engine, authPath string) (func(), error) {
	if os.Getenv("CXX_COMMUNICATOR_SYNC") == "1" {
		return func() {}, nil
	}
	return RecoveryFence(ctx, base, engine, authPath)
}

type pendingAuth struct {
	Generation string `json:"generation"`
}

func pendingPath(job syncJob) string {
	return filepath.Join(jobHome(job), ".cxx-communicator-pending-auth.json")
}
func pendingGeneration(job syncJob) string {
	return pendingGenerationAt(pendingPath(job))
}
func pendingGenerationAt(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ""
		}
		return "invalid"
	}
	var pending pendingAuth
	if json.Unmarshal(raw, &pending) != nil || !validPendingGeneration(pending.Generation) {
		return "invalid"
	}
	return pending.Generation
}
func validPendingGeneration(generation string) bool {
	if len(generation) != 64 || generation != strings.ToLower(generation) {
		return false
	}
	_, err := hex.DecodeString(generation)
	return err == nil
}
func writePending(job syncJob, generation string) error {
	if !validPendingGeneration(generation) {
		return errors.New("pending auth generation is not a SHA256 digest")
	}
	if err := os.MkdirAll(jobHome(job), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(jobHome(job), ".comm-pending-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	raw, _ := json.Marshal(pendingAuth{Generation: generation})
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(raw)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(f.Name(), pendingPath(job))
	}
	if err == nil {
		dir, openErr := os.Open(jobHome(job))
		if openErr != nil {
			return openErr
		}
		err = dir.Sync()
		dir.Close()
	}
	return err
}
func ambiguous(result SyncResult) bool {
	if result.Error == nil {
		return false
	}
	var h struct {
		StatusCode int
		Code       string
	}
	if json.Unmarshal(result.Error.HTTP, &h) == nil && h.StatusCode > 0 {
		return h.Code == "communicator_outcome_unknown"
	}
	return true
}

// PendingAuth prevents a finalizer from replaying an upload whose result was
// lost. A new native generation is independent and can be offered normally.
func PendingAuth(base, engine, path string) bool {
	if os.Getenv("CXX_COMMUNICATOR_SYNC") == "1" || engine == "grok" {
		return false
	}
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return true
		}
		if engine == "claude" {
			path = filepath.Join(home, ".claude", ".credentials.json")
		} else if engine == "codex" {
			root := os.Getenv("CODEX_HOME")
			if root == "" {
				root = filepath.Join(home, ".codex")
			}
			path = filepath.Join(root, "auth.json")
		}
	}
	if !filepath.IsAbs(path) || (engine != "codex" && engine != "claude") {
		return true
	}
	// A signed transport rollback cannot establish whether a prior store
	// committed. Its digest fence remains effective on the legacy path too.
	pending := pendingGenerationAt(filepath.Join(filepath.Dir(path), ".cxx-communicator-pending-auth.json"))
	return pending != "" && (pending == "invalid" || pending == fileGeneration(path))
}
