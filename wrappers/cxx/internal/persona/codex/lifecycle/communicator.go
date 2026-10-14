package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/authnotice"
	"io"
	"log/slog"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/summary"
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
	var material *authMaterializationError
	wire.Materialization = errors.As(err, &material)
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
	if wire.Materialization {
		err = &authMaterializationError{err: err}
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
	out, err := communicator.Sync(ctx, client.BaseURL, "codex", authPath, operation, includeAuth, concurrent, args, account, session)
	if err != nil {
		return out, err
	}
	if len(out.Auth) > 0 {
		client.Pool.Observe("/auth", out.Auth)
		var auth *orchestrator.AuthRetrieveResponse
		if json.Unmarshal(out.Auth, &auth) == nil {
			err = errors.Join(err, updateAuthSessionSecurityContext(ctx, auth))
		}
	}
	return out, errors.Join(err, syncErrorFromWire(out.Error))
}

// CommunicatorWork reuses the established native writers and auth arbitration.
// It deliberately never enters Run, PreExec, account selection or installation.
func CommunicatorWork(ctx context.Context, cfg *config.Config, req communicator.SyncRequest) communicator.SyncResult {
	if err := codex.GuardFQDN(cfg); err != nil {
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
	path, err := codex.AuthPath()
	if err != nil {
		return communicator.SyncResult{Error: syncError(err)}
	}
	client.Pool = accountpool.Load("codex", path, client.BaseURL)
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
		out.HostSecure = result.HostSecure
		out.HostStatus = result.HostStatus
		out.Generation = result.Generation.Digest
		out.Uploaded = result.Uploaded
		out.Adopted = result.Adopted
		out.Deferred = result.Deferred
		out.Error = syncError(err)
		if result.Adopted {
			_ = authnotice.Publish("codex", result.Generation.Digest)
		}
	case "skills":
		result := combineResourceSync(syncSkills(ctx, client, logger), pruneLegacySkillDirs(wrapperVersion(cfg), logger))
		out.Resources["skills"] = resourceToWire(result)
	case "bootstrap", "content":
		auth, err, synced, agents, settings, sessions := bootstrapWithProgress(ctx, client, logger, false, path, req.IncludeAuth, nil, req.Args)
		out.Auth, _ = json.Marshal(auth)
		out.AuthSynced = synced
		out.Sessions, _ = json.Marshal(sessions)
		out.Error = syncError(err)
		out.Resources = map[string]communicator.ResourceResult{"agents": resourceToWire(agents), "config": resourceToWire(settings)}
		if req.Operation == "content" {
			out.Resources["skills"] = resourceToWire(combineResourceSync(syncSkills(ctx, client, logger), pruneLegacySkillDirs(wrapperVersion(cfg), logger)))
		}
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
	raw, err := codex.ReadAuth()
	generation, genErr := codex.CurrentAuthGeneration()
	err = errors.Join(err, genErr)
	sum := sha256.Sum256(raw)
	if err == nil && (!generation.Exists || hex.EncodeToString(sum[:]) != generation.Digest) {
		err = errors.New("Auth changed during upload reconciliation")
	}
	same := func(payload json.RawMessage) bool { return codex.SameAuthCredentials(raw, payload) }
	acknowledge := func(digest string) (bool, error) { return codex.AcknowledgeCanonicalAuthGeneration(ctx, generation) }
	out := communicator.SyncResult{Generation: generation.Digest, Deferred: true}
	if err != nil {
		out.Error = syncError(err)
		return out
	}
	if client.Pool == nil {
		client.Pool = accountpool.Load("codex", path, client.BaseURL)
	}
	account, session := client.Pool.Binding()
	resp, err := client.AuthRetrieve(ctx, "")
	if err != nil {
		out.Error = syncError(err)
		return out
	}
	out.Error = &communicator.SyncError{Message: "Previous auth upload outcome remains unknown; local credentials retained; inspect with cdx auth-reconcile"}
	currentAccount, currentSession := client.Pool.Binding()
	if resp == nil || (resp.Engine != "" && resp.Engine != "codex") || resp.VerificationState != "verified" {
		return out
	}
	if same(resp.Auth) {
		acknowledged, err := acknowledge(resp.CanonicalDigest)
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
		localStamp, localErr := codex.LastRefreshFromRaw(raw)
		serverStamp, serverErr := codex.LastRefreshFromRaw(resp.Auth)
		if !codex.IsValidAuthPayload(raw) || localErr != nil || serverErr != nil || !serverStamp.After(localStamp) ||
			serverStamp.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) || serverStamp.After(time.Now().Add(5*time.Minute)) {
			return out
		}
		result, applyErr := applySessionAuthResponse(ctx, path, resp, SessionAuthSyncResult{Generation: generation})
		if applyErr != nil {
			out.Error = syncError(applyErr)
			return out
		}
		if !result.Adopted || result.Deferred {
			return out
		}
		out.Generation = result.Generation.Digest
		out.Adopted = true
		out.AuthSynced = true
		out.Deferred = false
		out.Error = nil
		_ = authnotice.Publish("codex", out.Generation)
	}
	out.Auth, _ = json.Marshal(resp)
	if resp.Host != nil {
		secure := resp.Host.Secure
		out.HostSecure = &secure
	}
	out.HostStatus = resp.Status
	if bootstrap && out.Deferred && out.Error == nil {
		out.Error = &communicator.SyncError{Message: "Auth changed during upload reconciliation"}
	}
	return out
}
