package cron

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/enginedestroy"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeentry"
)

var (
	destroyEngine  = enginedestroy.Run
	reportDestroy  = enginedestroy.Report
	destroyOptions = defaultDestroyOptions
)

func defaultDestroyOptions(ctx context.Context, executable string) (enginedestroy.Options, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return enginedestroy.Options{}, err
	}
	return enginedestroy.Options{
		Home: home,
		RemoveAlias: func(ctx context.Context, engine string) error {
			return layout.RemoveAlias(ctx, filepath.Dir(executable), engine)
		},
		RemoveShim: func(engine string) error {
			return nativeentry.Remove(nativeentry.Options{Home: home, Engines: []string{engine}})
		},
	}, nil
}

// applyDestroyRequests carries out the "destroy engine" directives found in
// the freshly fetched signed configs and removes the destroyed engines from
// fetched, so nothing re-persists their config or alias afterwards. It
// returns the destroyed engines (in directive order) for the caller's regular
// disabled-engine cleanup, which is idempotent.
//
// A directive is acted on once per request id: the local completion marker is
// written only after a fully clean run, so a partial failure retries on the
// next tick. Report failures never block the cleanup itself.
func applyDestroyRequests(ctx context.Context, seed *config.Config, fetched map[string]*fleetconfig.Fetched, executable string, warn io.Writer) []string {
	var directives []config.DestroyDirective
	seen := map[string]bool{}
	for _, item := range fetched {
		if item == nil || item.Config == nil {
			continue
		}
		for _, d := range item.Config.Host.DestroyEngines {
			if d.RequestID == "" || seen[d.Engine+"/"+d.RequestID] {
				continue
			}
			seen[d.Engine+"/"+d.RequestID] = true
			directives = append(directives, d)
		}
	}
	if len(directives) == 0 {
		return nil
	}
	opt, err := destroyOptions(ctx, executable)
	if err != nil {
		fmt.Fprintf(warnWriter(warn), "engine destroy skipped: %v\n", err)
		return nil
	}
	var destroyed []string
	for _, d := range directives {
		// The fetched config is already authoritative for this tick: never
		// re-persist or alias a destroyed engine, even if cleanup fails.
		delete(fetched, d.Engine)
		destroyed = append(destroyed, d.Engine)
		if enginedestroy.Done(opt.Home, d.Engine, d.RequestID) {
			continue
		}
		_ = reportDestroy(ctx, seed, d.Engine, d.RequestID, "running", nil)
		res, err := destroyEngine(ctx, d.Engine, opt)
		if err != nil {
			res.Residue = append(res.Residue, err.Error())
		}
		if res.Complete() {
			if merr := enginedestroy.MarkDone(opt.Home, d.Engine, d.RequestID); merr != nil {
				fmt.Fprintf(warnWriter(warn), "engine destroy %s: completion marker: %v\n", d.Engine, merr)
			}
			fmt.Fprintf(warnWriter(warn), "engine %s destroyed on this host (%d paths removed)\n", d.Engine, len(res.Removed))
			_ = reportDestroy(ctx, seed, d.Engine, d.RequestID, "done", nil)
			continue
		}
		fmt.Fprintf(warnWriter(warn), "engine %s destroy incomplete: %v\n", d.Engine, res.Residue)
		_ = reportDestroy(ctx, seed, d.Engine, d.RequestID, "failed", res.Residue)
	}
	return destroyed
}
