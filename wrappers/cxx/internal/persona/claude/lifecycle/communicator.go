package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/authnotice"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/summary"
)

func syncError(err error) *communicator.SyncError {
	if err == nil {
		return nil
	}
	wire := &communicator.SyncError{Message: err.Error()}
	var httpErr *orchestrator.HTTPError
	if errors.As(err, &httpErr) {
		wire.HTTP, _ = json.Marshal(httpErr)
	}

	return wire
}
func syncErrorFromWire(wire *communicator.SyncError) error {
	if wire == nil {
		return nil
	}
	var err error = errors.New(wire.Message)
	if len(wire.HTTP) > 0 {
		var h orchestrator.HTTPError
		if json.Unmarshal(wire.HTTP, &h) == nil {
			err = &h
		}
	}

	return err
}
func resourceToWire(r summary.ResourceSync) communicator.ResourceResult {
	return communicator.Resource(r.Checked, r.Updated, r.Err)
}
func resourceFromWire(r communicator.ResourceResult) summary.ResourceSync {
	return summary.ResourceSync{Checked: r.Checked, Updated: r.Updated, Err: r.Err()}
}

func sharedSync(ctx context.Context, client *orchestrator.Client, authPath, operation string, includeAuth, concurrent bool, args []string) (communicator.SyncResult, error) {
	account, session := client.Pool.Binding()
	out, err := communicator.Sync(ctx, client.BaseURL, "claude", authPath, operation, includeAuth, concurrent, args, account, session)
	if err != nil {
		return out, err
	}
	if len(out.Auth) > 0 {
		client.Pool.Observe("/auth", out.Auth)
	}
	return out, syncErrorFromWire(out.Error)
}

// CommunicatorWork reuses the established native writers and auth arbitration.
// It deliberately never enters Run, PreExec, account selection or installation.
func CommunicatorWork(ctx context.Context, cfg *config.Config, req communicator.SyncRequest) communicator.SyncResult {
	if err := claude.GuardFQDN(cfg); err != nil {
		return communicator.SyncResult{Error: syncError(err)}
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	ca := ""
	if cfg.Orchestrator.CABundlePath != nil {
		ca = *cfg.Orchestrator.CABundlePath
	}
	client, err := orchestrator.New(orchestrator.Options{BaseURL: cfg.Orchestrator.BaseURL, APIKey: cfg.Orchestrator.APIKey, AllowInsecure: cfg.Orchestrator.AllowInsecure, CABundlePath: ca, Logger: logger})
	if err != nil {
		return communicator.SyncResult{Error: syncError(err)}
	}
	path, err := claude.AuthPath()
	if err != nil {
		return communicator.SyncResult{Error: syncError(err)}
	}
	client.Pool = accountpool.Load("claude", path, client.BaseURL)
	if req.Job.SessionID != "" && client.Pool.AccountID > 0 && req.Job.AccountID != client.Pool.AccountID {
		return communicator.SyncResult{Error: &communicator.SyncError{Message: "native auth directory belongs to another account"}}
	}
	if req.Job.AccountID > 0 {
		client.Pool.AccountID = req.Job.AccountID
	}
	client.Pool.SessionID = req.Job.SessionID
	out := communicator.SyncResult{Resources: map[string]communicator.ResourceResult{}}
	var reconciled *communicator.SyncResult
	if req.ReconcileOnly {
		result := reconcileUnknownAuth(ctx, client, path, req.Operation == "bootstrap")
		if result.Error != nil || result.Deferred || req.Operation == "auth" {
			return result
		}
		reconciled = &result
		req.IncludeAuth = false
	}
	switch req.Operation {
	case "auth":
		result, err := SyncSessionAuth(ctx, client, logger)
		out.Generation = result.Generation.Digest
		out.Uploaded = result.Uploaded
		out.Adopted = result.Adopted
		out.Deferred = result.Deferred
		out.Error = syncError(err)
		out.HostSecure = result.HostSecure
	case "skills":
		result := combineResourceSync(syncSkills(ctx, client, logger), pruneLegacySkillDirs(wrapperVersion(cfg), logger))
		out.Resources["skills"] = resourceToWire(result)
	case "bootstrap", "content":
		auth, err, synced, agents, settings, nativeSkills, sessions := bootstrapWithProgress(ctx, client, logger, false, path, req.IncludeAuth, nil, req.Args)
		out.Auth, _ = json.Marshal(auth)
		out.AuthSynced = synced
		out.Sessions, _ = json.Marshal(sessions)
		out.Error = syncError(err)
		out.Resources = map[string]communicator.ResourceResult{"agents": resourceToWire(agents), "config": resourceToWire(settings), "skills": resourceToWire(nativeSkills)}
		if claude.HasUsableAuth() {
			ensureOnboardingState(logger)
		}
		nativeSkills = combineResourceSync(nativeSkills, pruneLegacySkillDirs(wrapperVersion(cfg), logger))
		out.Resources["skills"] = resourceToWire(nativeSkills)
	default:
		out.Error = &communicator.SyncError{Message: "unsupported sync operation"}
	}
	if reconciled != nil {
		out.Auth = reconciled.Auth
		out.AuthSynced = reconciled.Adopted
		out.Uploaded = reconciled.Uploaded
		out.Adopted = reconciled.Adopted
		out.Generation = reconciled.Generation
		out.HostSecure = reconciled.HostSecure
	}
	return out
}

// A previous write may have committed. A readback can acknowledge the same
// verified credential pair; a different head is not permission to replay it.
func reconcileUnknownAuth(ctx context.Context, client *orchestrator.Client, path string, bootstrap bool) communicator.SyncResult {
	snapshot, err := claude.ReadAuthSnapshotContext(ctx, false)
	generation := snapshot.Generation
	same := func(payload json.RawMessage) bool { return claude.SameCredentialPair(snapshot.Raw, payload) }
	acknowledge := func(digest string) (bool, error) { return claude.AcknowledgeAuthGeneration(ctx, generation, digest) }
	out := communicator.SyncResult{Generation: generation.Digest, Deferred: true}
	if err != nil {
		out.Error = syncError(err)
		return out
	}
	if client.Pool == nil {
		client.Pool = accountpool.Load("claude", path, client.BaseURL)
	}
	account, session := client.Pool.Binding()
	resp, err := client.AuthRetrieve(ctx, "")
	if err != nil {
		out.Error = syncError(err)
		return out
	}
	out.Error = &communicator.SyncError{Message: "Previous auth upload outcome remains unknown; local credentials retained; inspect with clx auth-reconcile"}
	currentAccount, currentSession := client.Pool.Binding()
	if resp == nil || (resp.Engine != "" && resp.Engine != "claude") || resp.VerificationState != "verified" {
		return out
	}
	if same(resp.Auth) {
		digest := resp.CanonicalDigest
		if digest == "" {
			digest = resp.Digest
		}
		acknowledged, err := acknowledge(digest)
		out.Error = syncError(err)
		out.Deferred = !acknowledged
		out.Uploaded = acknowledged
	} else {
		// Identical verified credentials retain the existing acknowledgement
		// behavior even for legacy/unbound jobs. Replacing credentials needs
		// an unchanged explicit binding; a newly selected account is not proof.
		if resp.AccountID != account || currentAccount != account || currentSession != session {
			return out
		}
		// Readback is never permission to retry the interrupted store. A verified,
		// strictly newer canonical can replace only the exact local generation we
		// observed, through the existing writer that preserves logout/native races.
		serverStamp, serverErr := claude.LastRefreshFromRaw(resp.Auth)
		if serverErr != nil {
			serverStamp, serverErr = time.Parse(time.RFC3339Nano, resp.CanonicalLastRefresh)
		}
		if !snapshot.Usable || snapshot.LastRefresh.IsZero() || serverErr != nil || !serverStamp.After(snapshot.LastRefresh) ||
			serverStamp.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) || serverStamp.After(time.Now().Add(5*time.Minute)) ||
			!claude.ServerAuthMayReplace(snapshot, resp.Auth, resp.CanonicalLastRefresh, resp.VerificationState, false) {
			return out
		}
		adopted, applied, applyErr := claude.WriteSessionAuthIfCurrentWithDigest(ctx, resp.Auth, resp.CanonicalDigest, resp.VerificationState, generation)
		if applyErr != nil {
			out.Error = syncError(applyErr)
			return out
		}
		if !applied {
			return out
		}
		out.Generation = adopted.Digest
		out.Adopted = true
		out.AuthSynced = true
		out.Deferred = false
		out.Error = nil
		_ = authnotice.Publish("claude", out.Generation)
	}
	out.Auth, _ = json.Marshal(resp)
	if secure, known := resp.HostSecurity(); known {
		out.HostSecure = &secure
	}
	if bootstrap && out.Deferred && out.Error == nil {
		out.Error = &communicator.SyncError{Message: "Auth changed during upload reconciliation"}
	}
	return out
}
