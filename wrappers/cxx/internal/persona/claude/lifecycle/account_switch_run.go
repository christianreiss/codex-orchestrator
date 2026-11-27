package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/authnotice"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

// startAccountSwitcher wires live account switching for one Claude launch
// that holds a provider lease, and serves the cxx-agent account tools. It
// returns an idempotent stop that waits for the supervisor.
func startAccountSwitcher(ctx context.Context, client *orchestrator.Client, connection *agentportal.ConnectionRuntime, watch *restartableAuthWatch, logger *slog.Logger) func() {
	pool := client.Pool
	authPath, err := claude.AuthPath()
	if pool == nil || err != nil {
		return func() {}
	}
	projects := filepath.Join(filepath.Dir(authPath), "projects")
	// pausedRound is the pause round in which the whole scope is at rest:
	// the server marked it ready, and the hooks of every live session of the
	// scope still say so (looked at again here, because a hold can run out
	// between a session's report and this moment).
	pausedRound := func() (string, bool) {
		now := time.Now()
		command, _, ok := pool.Pause(now)
		if !ok || !command.Ready {
			return "", false
		}
		if safe, _ := pool.ScopeSafe(command.Round, now); !safe {
			return "", false
		}
		return command.Round, true
	}
	// earlyFlush is the flush a supervisor runs when its session is asked to
	// pause. It still stands when the round becomes ready, unless the
	// credentials file changed since.
	var earlyFlush struct {
		round  string
		result flushResult
	}
	deps := &accountSwitchDeps{
		pool:      pool,
		heartbeat: func(c context.Context) error { return pool.Heartbeat(c, client) },
		idle: func() bool {
			// A ready pause round is a turn boundary made on purpose: every
			// thread of every session waits at a hook or runs a tool.
			if _, paused := pausedRound(); paused {
				return true
			}
			// Hook evidence decides for this session and for every sibling
			// that publishes its own (session markers). The transcript check
			// stays on top: it is all there is for a sibling that publishes
			// nothing, and it never makes a busy scope look idle.
			if idle, known := connection.ClaudeTurnIdle(); known && !idle {
				return false
			}
			if busy, _ := pool.SiblingTurns(); busy {
				return false
			}
			return scopeTranscriptsQuiet(projects, time.Now())
		},
		flush: func(c context.Context, relaxed bool) (flushResult, error) {
			fctx, cancel := context.WithTimeout(c, 30*time.Second)
			defer cancel()
			command, _, pausing := pool.Pause(time.Now())
			if pausing && command.Ready && earlyFlush.round == command.Round {
				if snap, err := claude.ReadAuthSnapshotContext(fctx, false); err == nil && snap.Generation == earlyFlush.result.Generation {
					return earlyFlush.result, nil
				}
			}
			flushed, err := flushAccountAuth(fctx, client, logger, relaxed)
			if bound, _ := pool.Binding(); err == nil && flushed.Bound != nil && flushed.Bound.AccountID == bound {
				flushed.Bound.AccountLabel = pool.Label()
			}
			earlyFlush.round = ""
			if err == nil && pausing && flushed.Bound == nil {
				earlyFlush.round, earlyFlush.result = command.Round, flushed
			}
			return flushed, err
		},
		report: func(c context.Context, d accountpool.SwitchDirective) error {
			rctx, cancel := context.WithTimeout(c, 20*time.Second)
			defer cancel()
			return pool.ReportUnfinishedSwitch(rctx, client, d)
		},
		markRepair:    pool.MarkRepair,
		clearRepair:   pool.ClearRepair,
		repairPending: pool.RepairPending,
		commit: func(c context.Context, d accountpool.SwitchDirective) (*accountpool.LeaseResponse, error) {
			cctx, cancel := context.WithTimeout(c, 20*time.Second)
			defer cancel()
			return pool.CommitSwitch(cctx, client, d)
		},
		apply: pool.ApplySwitch,
		write: func(c context.Context, res *accountpool.LeaseResponse, expected claude.AuthGeneration) (claude.AuthGeneration, bool, error) {
			release, err := communicator.Fence(c, client.BaseURL, "claude", authPath)
			if err != nil {
				return claude.AuthGeneration{}, false, err
			}
			defer release()
			var generation claude.AuthGeneration
			var applied bool
			if _, paused := pausedRound(); paused {
				// Every session of the scope is held at a hook, this one too,
				// so there is no turn gate to take: its prompt hook is among
				// the held ones.
				wctx, cancel := context.WithTimeout(c, 2*time.Second)
				defer cancel()
				generation, applied, err = claude.WriteSwitchedAccountIfCurrent(wctx, res.Auth, res.CanonicalDigest, res.VerificationState, expected)
				return generation, applied, err
			}
			siblingBusy := false
			ran, _, err := connection.WhileClaudeTurnIdle(func() error {
				// A sibling's prompt hook publishes its turn before it returns:
				// look once more with the own turn gate held.
				if siblingBusy, _ = pool.SiblingTurns(); siblingBusy {
					return nil
				}
				// Short bound: a native prompt hook may be queued behind us.
				wctx, cancel := context.WithTimeout(c, 2*time.Second)
				defer cancel()
				var werr error
				generation, applied, werr = claude.WriteSwitchedAccountIfCurrent(wctx, res.Auth, res.CanonicalDigest, res.VerificationState, expected)
				return werr
			})
			if !ran || siblingBusy {
				return claude.AuthGeneration{}, false, errTurnBusy
			}
			return generation, applied, err
		},
		matches: func(c context.Context, res *accountpool.LeaseResponse) (claude.AuthGeneration, bool) {
			snap, err := claude.ReadAuthSnapshotContext(c, false)
			if err != nil || !snap.Usable || !claude.SameCredentialPair(snap.Raw, res.Auth) {
				return claude.AuthGeneration{}, false
			}
			return snap.Generation, true
		},
		pauseSync:  watch.Pause,
		resumeSync: watch.Resume,
		done: func(previousID int64, previousLabel string, res *accountpool.LeaseResponse, generation claude.AuthGeneration, reason string) {
			// Claude Code refetches the account profile itself after the
			// credentials change, so ~/.claude.json (oauthAccount) is left to
			// it: the switch response carries no profile to write there.
			detail := accountSwitchNotice(previousID, previousLabel, res.AccountID, res.AccountLabel, reason)
			if previousID == res.AccountID {
				detail = accountRepairNotice(res.AccountID, res.AccountLabel)
			}
			if err := authnotice.PublishDetail("claude", generation.Digest, detail); err != nil {
				logger.Warn("Claude account switch notice unavailable", "err", err)
			}
			logger.Info("Claude account switched live", "from", previousID, "to", res.AccountID, "reason", reason)
		},
		pauseRound: func() (string, bool) {
			command, _, ok := pool.Pause(time.Now())
			if !ok {
				return "", false
			}
			if !command.Ready {
				return command.Round, false
			}
			_, paused := pausedRound()
			return command.Round, paused
		},
		pauseReport: func(c context.Context, round, state, reason string) {
			rctx, cancel := context.WithTimeout(c, 10*time.Second)
			defer cancel()
			if err := pool.ReportPause(rctx, client, round, state, reason); err != nil {
				logger.Warn("account pause: outcome not reported", "state", state, "err", err)
			}
		},
		repairSince: pool.RepairSince,
		reportRepair: func(c context.Context) error {
			rctx, cancel := context.WithTimeout(c, 20*time.Second)
			defer cancel()
			return pool.ReportUnfinishedRepair(rctx, client)
		},
		logger:     logger,
		pollEvery:  accountSwitchPollEvery,
		gateEvery:  accountSwitchGateEvery,
		retryEvery: accountSwitchRetryEvery,
	}
	// A sibling in the same scope committed the switch and normally wrote the
	// credentials and published the notice to the shared mailbox; the auth
	// registration follows here. Normally: the sibling may have died between
	// its commit and its write, so the adoption is checked like any other
	// binding the file may not follow yet.
	pool.OnAdopt(func(a accountpool.Adoption) {
		pool.MarkRepair()
		// The sibling writes right after its commit (no network in between,
		// scope already quiet); a short settle keeps the re-registered
		// watcher from starting on the old account's file. Losing that race
		// is benign: the old login uploads by identity to its own account.
		go func() {
			if sleepContext(ctx, accountAdoptSettle) {
				watch.Restart()
				pool.Poke()
			}
		}()
		logger.Info("Claude account switch adopted from sibling session", "from", a.PreviousAccountID, "to", a.AccountID)
	})
	connection.SetAccountHandler(accountToolHandler(client, pool))
	// Siblings read this launch's turn from its session marker.
	connection.SetClaudeTurnObserver(pool.SetSessionTurn)
	sctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		runAccountSwitcher(sctx, deps)
	}()
	paused := make(chan struct{})
	go func() {
		defer close(paused)
		runPauseAgent(sctx, &pauseAgentDeps{
			pool: pool,
			report: func(c context.Context, round, state, reason string) error {
				rctx, cancel := context.WithTimeout(c, 10*time.Second)
				defer cancel()
				return pool.ReportPause(rctx, client, round, state, reason)
			},
			logger: logger,
		})
	}()
	stopped := false
	return func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		<-done
		<-paused
		connection.SetClaudeTurnObserver(nil)
	}
}

// sessionAuthSync is SyncSessionAuth, replaceable in tests.
var sessionAuthSync = SyncSessionAuth

// confirmedAuthGeneration returns the local generation once the server has
// confirmed exactly that file.
var confirmedAuthGeneration = func(ctx context.Context) (claude.AuthGeneration, error) {
	snap, err := claude.ReadAuthForRetrieveSnapshotContext(ctx)
	if err != nil {
		return claude.AuthGeneration{}, err
	}
	if !snap.Usable || snap.ServerDigest == "" {
		return claude.AuthGeneration{}, errors.New("local Claude credentials are not yet confirmed by the server")
	}
	return snap.Generation, nil
}

// flushAccountAuth runs the regular session sync and succeeds only when
// nothing of the local credentials is left to upload: they are exactly a head
// the server confirmed. Its generation fences the switched write.
//
// The server answers for the account it has the scope bound to. When the
// local file is another account's login it says so (BoundAccountMismatch);
// that file is flushed all the same, and the result carries the bound
// account's head. An upload is filed by the login's own identity and its
// answer cannot tell, so one more exchange follows it.
//
// relaxed (the account being left is paused, being removed or unverified)
// also accepts a file the server knows, accepted or refused for good although
// it confirms no head for that account. An account being removed takes no
// login from a host that no longer holds a lease on it, which is the case
// once the commit moved the scope: that refusal is final too. Any other
// conflict, an unavailable server or a network error still fail: the upload
// may yet succeed.
func flushAccountAuth(ctx context.Context, client *orchestrator.Client, logger *slog.Logger, relaxed bool) (flushResult, error) {
	result, err := sessionAuthSync(ctx, client, logger)
	if err == nil && result.Uploaded {
		result, err = sessionAuthSync(ctx, client, logger)
	}
	var mismatch *BoundAccountMismatch
	if errors.As(err, &mismatch) {
		return flushResult{Generation: mismatch.Generation, Bound: &accountpool.LeaseResponse{
			AccountID: mismatch.BoundAccountID, Auth: mismatch.Auth,
			CanonicalDigest: mismatch.CanonicalDigest, VerificationState: mismatch.VerificationState,
		}}, nil
	}
	if err != nil {
		var refused *orchestrator.HTTPError
		retired := errors.As(err, &refused) && refused.StatusCode == http.StatusConflict && refused.Code == "account_removed"
		nothingLeft := retired || orchestrator.IsDefinitiveAuthCandidateRejection(err) ||
			(errors.Is(err, ErrSessionAuthUnverified) && (result.ServerKnown || result.Uploaded || result.Rejected))
		if relaxed && nothingLeft && !result.Deferred && result.Generation.Exists {
			return flushResult{Generation: result.Generation}, nil
		}
		return flushResult{}, err
	}
	if result.Deferred {
		return flushResult{}, errors.New("local Claude credentials are not settled (native change or logout)")
	}
	generation, err := confirmedAuthGeneration(ctx)
	return flushResult{Generation: generation}, err
}

// accountToolHandler serves account_status and account_switch for the agent.
func accountToolHandler(client *orchestrator.Client, pool *accountpool.Context) agentportal.AccountHandler {
	return func(ctx context.Context, op string, args json.RawMessage) (any, error) {
		_, session := pool.Binding()
		if session == "" {
			return nil, &agentportal.AccountError{Status: http.StatusConflict, Code: "account_session_missing", Message: "This launch holds no provider account lease"}
		}
		switch op {
		case "status":
			raw, err := accountpool.ListAccounts(ctx, client, "claude", session)
			if err != nil {
				return nil, accountToolError(err)
			}
			return raw, nil
		case "switch":
			target, err := parseSwitchTarget(args)
			if err != nil {
				return nil, &agentportal.AccountError{Status: http.StatusBadRequest, Code: "account_switch_target_invalid", Message: err.Error()}
			}
			res, err := accountpool.RequestSwitch(ctx, client, "claude", session, target, "agent")
			if err != nil {
				return nil, accountToolError(err)
			}
			pool.Poke()
			out := map[string]any{"bound_account_id": res.BoundAccountID, "binding_generation": res.BindingGeneration, "account_switch": res.AccountSwitch}
			if res.AccountSwitch == nil {
				out["note"] = "No switch pending: the policy keeps the currently bound account."
			} else {
				out["note"] = "Switch requested. It takes effect at the next turn boundary, after this turn ends; keep working."
			}
			return out, nil
		}
		return nil, &agentportal.AccountError{Status: http.StatusNotFound, Code: "account_operation_unknown", Message: "Unknown account operation"}
	}
}

func parseSwitchTarget(raw json.RawMessage) (any, error) {
	var args struct {
		Target json.RawMessage `json:"target"`
	}
	if json.Unmarshal(raw, &args) != nil || len(args.Target) == 0 {
		return nil, errors.New(`target is required: an account id or "auto"`)
	}
	var name string
	if json.Unmarshal(args.Target, &name) == nil {
		name = strings.TrimSpace(name)
		if name == "auto" {
			return "auto", nil
		}
		return nil, errors.New(`target must be an account id or "auto"`)
	}
	var number float64
	if json.Unmarshal(args.Target, &number) != nil || number < 1 || number != math.Trunc(number) || number > math.MaxInt32 {
		return nil, errors.New(`target must be an account id or "auto"`)
	}
	return int64(number), nil
}

func accountToolError(err error) error {
	var httpErr *orchestrator.HTTPError
	if !errors.As(err, &httpErr) {
		return err
	}
	return &agentportal.AccountError{Status: httpErr.StatusCode, Code: httpErr.Code, Message: httpErr.ServerMessage()}
}
