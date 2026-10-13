package communicator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

// WorkerCommand is a private finite dispatcher, entered before persona startup,
// native-entry reconciliation, cron installation or engine maintenance.
func WorkerCommand(ctx context.Context, in io.Reader, out io.Writer, dispatch func(context.Context, *config.Config, SyncRequest) SyncResult) int {
	var req SyncRequest
	if err := json.NewDecoder(io.LimitReader(in, 1<<20)).Decode(&req); err != nil {
		return 1
	}
	if validateJob(req.Job) != nil || os.Getenv("CXX_COMMUNICATOR_SYNC") != "1" {
		return 1
	}
	key, err := signing.PublicKey()
	if err != nil {
		return 1
	}
	cfg, err := config.LoadForEngine(req.Job.Config, key, false, req.Job.Engine)
	if err != nil {
		return 1
	}
	socket, err := socketPath(cfg.Orchestrator.BaseURL)
	if err != nil {
		return 1
	}
	// Held by the worker itself: even if its daemon dies, a replacement owner
	// cannot overlap an already accepted file transaction.
	var lock *ipc.Lock
	for {
		lock, err = ipc.TryAcquireExclusivePath(filepath.Join(filepath.Dir(socket), "sync-"+scopeID(req.Job)+".lock"))
		if !errors.Is(err, ipc.ErrHeld) {
			break
		}
		select {
		case <-ctx.Done():
			return 1
		case <-time.After(25 * time.Millisecond):
		}
	}
	if err != nil {
		return 1
	}
	defer lock.Release()
	Configure(ctx)
	// Configure normally discovers all installed engines. The worker's explicit
	// signed path is authoritative even for --config and isolated test users.
	base := strings.TrimRight(cfg.Orchestrator.BaseURL, "/")
	registry.LoadOrStore(base, &endpoint{base: base, path: req.Job.Config, socket: socket, syncProtocol: cfg.Orchestrator.CommunicatorSyncProtocol})
	os.Setenv("CXX_PROVIDER_ACCOUNT_ID", fmt.Sprint(req.Job.AccountID))
	os.Setenv("CXX_PROVIDER_SESSION_ID", req.Job.SessionID)
	// Persist only a digest before an auth-capable transaction. A killed worker
	// or lost ACK is reconciled by a read before the same candidate is offered again.
	authWork := req.Job.Engine != "grok" && (req.Operation == "auth" || (req.Operation == "bootstrap" && req.IncludeAuth))
	generation := fileGeneration(req.Job.AuthPath)
	if authWork && generation != "" {
		pending := pendingGeneration(req.Job)
		req.ReconcileOnly = pending == generation || pending == "invalid"
		if err := writePending(req.Job, generation); err != nil {
			_ = json.NewEncoder(out).Encode(syncFailure(err))
			return 0
		}
	}
	result := dispatch(ctx, cfg, req)
	if authWork && generation != "" && pendingGeneration(req.Job) == generation && !ambiguous(result) && (!req.ReconcileOnly || !result.Deferred && result.Error == nil) {
		_ = os.Remove(pendingPath(req.Job))
	}
	if json.NewEncoder(out).Encode(result) != nil {
		return 1
	}
	return 0
}
