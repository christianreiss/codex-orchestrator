package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	ui "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
)

type engineUpdateJob struct {
	e                               engineUpdate
	ctx                             context.Context
	row                             *ui.UpdateRow
	before, version, target, status string
	tone                            ui.Tone
	err                             error
	syncAllowed, done               bool
	code                            int
}

// Only independent checks and private native installations overlap. Credential
// guards, content/auth sync, version reports and daemon changes stay serialized.
func updateEngines(ctx context.Context, w io.Writer, caps ui.Caps, engines []engineUpdate, deps hostUpdateDeps) int {
	labels := make([]string, len(engines))
	for i, e := range engines {
		labels[i] = config.EngineLabel(e.name)
	}
	display := ui.StartUpdateRun(w, caps, labels)
	defer display.Close()
	jobs := make([]*engineUpdateJob, len(engines))
	for i, e := range engines {
		row := display.Row(i)
		jobs[i] = &engineUpdateJob{e: e, ctx: updateprogress.WithObserver(ctx, row.Observe), row: row, syncAllowed: true, status: "up to date", tone: ui.ToneOK}
	}
	parallelJobs(jobs, func(j *engineUpdateJob) { j.prepare(deps) })
	for _, j := range jobs {
		if !j.done && j.err == nil && j.target != "" {
			if j.ctx.Err() != nil {
				j.cancel()
				continue
			}
			j.row.Observe(updateprogress.Event{Phase: "protecting credentials"})
			j.err = deps.protect(j.ctx, j.e.cfg)
			j.syncAllowed = j.err == nil
		}
	}
	parallelJobs(jobs, func(j *engineUpdateJob) { j.install(deps) })
	worst := 0
	for _, j := range jobs {
		j.complete(deps)
		if j.code != 0 {
			worst = 1
		}
	}
	return worst
}

func parallelJobs(jobs []*engineUpdateJob, work func(*engineUpdateJob)) {
	var workers sync.WaitGroup
	for _, j := range jobs {
		workers.Add(1)
		go func() { defer workers.Done(); work(j) }()
	}
	workers.Wait()
}

func (j *engineUpdateJob) finish(code int, tone ui.Tone, status string) {
	j.done, j.code = true, code
	version := j.version
	if j.before != "" && version != j.before {
		version = j.before + " → " + version
	}
	j.row.Finish(tone, version, status)
}

func (j *engineUpdateJob) cancel() { j.finish(1, ui.ToneFail, "cancelled") }

func (j *engineUpdateJob) prepare(deps hostUpdateDeps) {
	if j.ctx.Err() != nil {
		j.cancel()
		return
	}
	if j.e.loadErr != nil {
		j.finish(1, ui.ToneFail, "config failed: "+j.e.loadErr.Error())
		return
	}
	if j.e.cfg.EngineSuspended(j.e.name) {
		j.finish(0, ui.ToneWarn, "skipped: suspended fleet-wide")
		return
	}
	j.before = deps.version(j.ctx, j.e.name)
	j.version = j.before
	j.row.SetVersion(j.before)
	j.err = j.e.checkErr
	if j.e.check == nil && j.err == nil {
		j.e.check, j.err = deps.check(j.ctx, j.e.cfg, j.before)
	}
	if j.err == nil && j.e.check == nil {
		j.err = errors.New("empty update check response")
	}
	if j.err != nil {
		j.syncAllowed = false
		return
	}
	check := j.e.check
	switch {
	case check.Action == "disable":
		j.status, j.tone = "skipped: binary updates disabled", ui.ToneWarn
	case nativeOverride(j.e.name):
		j.status, j.tone = "skipped: binary override", ui.ToneWarn
	case j.before == "" && check.Action != "update":
		j.err, j.syncAllowed = errors.New("native CLI missing; no installation authorized"), false
	case check.Action == "update":
		target := check.TargetVersion
		if target == "" {
			target = check.ClientVersion
		}
		if target == "" {
			j.err = errors.New("update requested without target version")
		} else if target != j.before {
			j.target = target
			j.row.SetVersion(j.before + " → " + target)
		}
	}
}

func (j *engineUpdateJob) install(deps hostUpdateDeps) {
	if j.done {
		return
	}
	if j.ctx.Err() != nil {
		j.cancel()
		return
	}
	if j.err == nil && j.target != "" {
		j.row.Observe(updateprogress.Event{Phase: "installing"})
		j.err = deps.install(j.ctx, j.e.name, j.target, j.e.check.EnforceExact)
		j.version = deps.version(j.ctx, j.e.name)
		if j.err == nil && (j.version == "" || (j.e.check.EnforceExact && j.version != j.target)) {
			j.err = fmt.Errorf("installed version %q does not match target %s", j.version, j.target)
		}
		if j.err == nil && j.version != j.before {
			j.status = "updated"
			if j.before == "" {
				j.status = "installed"
			}
		} else if j.err == nil && j.version != j.target {
			j.status, j.tone = "kept newer installed version", ui.ToneWarn
		}
	}
	if j.ctx.Err() != nil {
		j.cancel()
		return
	}
	if j.err != nil && !j.syncAllowed {
		j.finish(1, ui.ToneFail, "update failed: "+j.err.Error()+" · sync skipped")
		return
	}
	j.row.SetVersion(j.version)
	j.row.Observe(updateprogress.Event{Phase: "waiting for sync"})
}

func (j *engineUpdateJob) complete(deps hostUpdateDeps) {
	if j.done {
		return
	}
	if j.ctx.Err() != nil {
		j.cancel()
		return
	}
	if j.err != nil {
		j.status, j.tone, j.code = "update failed: "+j.err.Error(), ui.ToneFail, 1
	}
	j.row.Observe(updateprogress.Event{Phase: "syncing"})
	syncErr := deps.sync(j.ctx, j.e.cfg)
	if j.ctx.Err() != nil {
		j.cancel()
		return
	}
	reportErr := deps.report(j.ctx, j.e.cfg, j.version)
	if syncErr == nil {
		j.status += " · synced"
	} else if errors.Is(syncErr, ipc.ErrHeld) || strings.Contains(syncErr.Error(), "managed sync paused by an active session") {
		j.status += " · sync paused: active session"
		if j.tone != ui.ToneFail {
			j.tone = ui.ToneWarn
		}
		j.code = 1
	} else {
		j.status += " · sync failed: " + syncErr.Error()
		j.tone, j.code = ui.ToneFail, 1
	}
	if reportErr != nil {
		j.status += " · version report failed: " + reportErr.Error()
		j.tone, j.code = ui.ToneFail, 1
	}
	j.finish(j.code, j.tone, j.status)
}
