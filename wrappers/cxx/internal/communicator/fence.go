package communicator

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
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
	for {
		lock, err := ipc.TryAcquireExclusivePath(filepath.Join(filepath.Dir(ep.socket), "sync-"+scopeID(job)+".lock"))
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

type pendingAuth struct {
	Generation string `json:"generation"`
}

func pendingPath(job syncJob) string {
	return filepath.Join(jobHome(job), ".cxx-communicator-pending-auth.json")
}
func pendingGeneration(job syncJob) string {
	raw, err := os.ReadFile(pendingPath(job))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ""
		}
		return "invalid"
	}
	var pending pendingAuth
	if json.Unmarshal(raw, &pending) != nil {
		return "invalid"
	}
	return pending.Generation
}
func writePending(job syncJob, generation string) error {
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
	if endpointFor(base) == nil || os.Getenv("CXX_COMMUNICATOR_SYNC") == "1" {
		return false
	}
	job, err := newSyncJob(context.Background(), base, engine, path)
	if err != nil {
		return true
	}
	pending := pendingGeneration(job)
	return pending != "" && (pending == "invalid" || pending == fileGeneration(path))
}
