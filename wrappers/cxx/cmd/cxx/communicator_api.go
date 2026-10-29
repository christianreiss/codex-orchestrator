package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
)

// apiAttempt is the persisted below-minimum state. On-demand owners exit after
// five idle minutes and after every update, so an in-memory backoff would
// restart with each owner; the record keeps one backoff per running binary.
type apiAttempt struct {
	Config   string    `json:"config"`
	Running  string    `json:"running"`
	MinAPI   int       `json:"min_api"`
	Target   string    `json:"target,omitempty"`
	Attempts int       `json:"attempts"`
	Until    time.Time `json:"until"`
	Reason   string    `json:"reason,omitempty"`
}

func defaultAPIStatePath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".cxx", "api-update.json")
}

// loadAPIAttempt returns the record for this owner (config, binary and
// minimum); anything else, missing or unreadable is a fresh start.
func (u *commUpdater) loadAPIAttempt(min int) apiAttempt {
	fresh := apiAttempt{Config: u.env.ConfigPath(), Running: u.running, MinAPI: min}
	if u.apiStatePath == "" {
		return fresh
	}
	raw, err := os.ReadFile(u.apiStatePath)
	if err != nil {
		return fresh
	}
	var rec apiAttempt
	if json.Unmarshal(raw, &rec) != nil || rec.Config != fresh.Config || rec.Running != fresh.Running || rec.MinAPI != min {
		return fresh
	}
	return rec
}

func (u *commUpdater) saveAPIAttempt(rec apiAttempt) {
	if u.apiStatePath == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(u.apiStatePath), 0o700); err != nil {
		return
	}
	raw, err := json.Marshal(rec)
	if err != nil {
		return
	}
	tmp := u.apiStatePath + ".tmp"
	if os.WriteFile(tmp, raw, 0o600) == nil {
		_ = os.Rename(tmp, u.apiStatePath)
	}
}

func (u *commUpdater) clearAPIAttempt() {
	if u.apiStatePath != "" {
		_ = os.Remove(u.apiStatePath)
	}
}

// apiDelay is the exponential backoff after the n-th fruitless attempt.
func (u *commUpdater) apiDelay(n int) time.Duration {
	d := u.apiBase
	for i := 1; i < n && d < u.apiCap; i++ {
		d *= 2
	}
	if d > u.apiCap {
		d = u.apiCap
	}
	return d
}

// enforceMinimum handles C < min_api: the update is immediate, independent of
// running agents, and the owner is replaced right after it. It returns false
// (leaving the pass to the ordinary quiet-gated path) unless this binary is
// below the server's declared minimum. An attempt that cannot raise the level
// (no newer published binary, a failed install, an install that did not take
// effect) backs off exponentially up to apiCap, persisted across owners, with
// one log line per backoff period; it never hot-loops downloads.
func (u *commUpdater) enforceMinimum(ctx context.Context) bool {
	levels := u.env.API()
	if communicator.APIPolicy(u.apiVersion, levels) != communicator.APIStateUpdateRequired {
		u.env.ReportAPIBackoff(communicator.APIBackoff{})
		if u.apiStatePath != "" {
			if _, err := os.Stat(u.apiStatePath); err == nil {
				u.clearAPIAttempt()
			}
		}
		return false
	}
	rec := u.loadAPIAttempt(levels.Min)
	now := u.now()
	if now.Before(rec.Until) {
		if u.apiReplacing {
			// This owner applied the update and is being replaced (on-demand
			// drain or the root handoff); that is not a stuck state.
			u.env.ReportAPIBackoff(communicator.APIBackoff{})
			return true
		}
		// Still inside a backoff period: nothing newer was offered, or an
		// earlier owner on this same binary already applied an update that
		// did not take effect.
		reason := rec.Reason
		if reason == "" {
			reason = "update_did_not_take_effect"
		}
		u.env.ReportAPIBackoff(communicator.APIBackoff{Until: rec.Until, Reason: reason})
		return true
	}
	u.apiReplacing = false
	counted := false
	backoff := func(t *updateTarget, reason string) bool {
		if !counted {
			rec.Attempts++
		}
		// The period starts when this attempt ended: an install (with its
		// engine updates) can outlast the first delay.
		rec.Until = u.now().Add(u.apiDelay(rec.Attempts))
		rec.Reason = reason
		if t != nil {
			rec.Target = t.Version
		}
		u.saveAPIAttempt(rec)
		u.env.ReportAPIBackoff(communicator.APIBackoff{Until: rec.Until, Reason: reason})
		u.logf("server requires cxx API level %d but cxx %s speaks %d and the immediate update could not raise it (%s); next attempt %s. Publish a cxx release with API level %d or lower min_api, check auto-update and fleet locks for this host, then run 'cxx update'",
			levels.Min, u.running, u.apiVersion, reason, rec.Until.UTC().Format(time.RFC3339), levels.Min)
		return true
	}
	target, reason := u.detect(ctx)
	if target == nil {
		if reason == "" {
			reason = "no_newer_release"
		}
		return backoff(nil, reason)
	}
	if cfg := u.prefetchConfig(); cfg == nil {
		u.report("failed", target, 0, "config_unavailable")
		return backoff(target, "config_unavailable")
	} else if err := u.prefetch(ctx, cfg, *target); err != nil {
		u.report("failed", target, 0, "prefetch_failed")
		return backoff(target, "prefetch_failed")
	}
	exe, err := u.target()
	if err != nil {
		u.report("failed", target, 0, "executable_unresolved")
		return backoff(target, "executable_unresolved")
	}
	if !u.writable(exe) {
		u.report("requires_root", target, 0, "")
		return backoff(target, "requires_root")
	}
	// Record the attempt before applying: if the next owner still runs this
	// binary, it starts inside this backoff period instead of re-applying.
	rec.Attempts++
	rec.Target = target.Version
	rec.Until = now.Add(u.apiDelay(rec.Attempts))
	rec.Reason = ""
	u.saveAPIAttempt(rec)
	counted = true
	agents := u.agents()
	u.logf("server requires cxx API level %d and cxx %s speaks %d: installing %s now and replacing this owner with %d agent(s) online (operator-requested exception to the quiet gate)",
		levels.Min, u.running, u.apiVersion, target.Version, agents)
	u.report("applying", target, agents, "api_below_minimum")
	if err := u.apply(ctx, exe); err != nil {
		u.report("failed", target, 0, "apply_failed")
		return backoff(target, "apply_failed")
	}
	// Restart the period from the end of the install so a successor on the
	// same binary (the install did not take effect) cannot find it expired.
	rec.Until = u.now().Add(u.apiDelay(rec.Attempts))
	u.saveAPIAttempt(rec)
	u.apiReplacing = true
	u.env.ReportAPIBackoff(communicator.APIBackoff{})
	if u.env.Resident() {
		if err := u.handoff(*target, exe); err != nil {
			u.report("failed", target, 0, "handoff_request_failed")
			return backoff(target, "handoff_request_failed")
		}
		u.report("handoff_requested", target, 0, "api_below_minimum")
		return true
	}
	u.report("applied", target, 0, "api_below_minimum")
	u.env.RetireNow("cxx API level below the server's minimum; replaced by " + target.Version)
	return true
}
