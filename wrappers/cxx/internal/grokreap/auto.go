package grokreap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
)

// Defaults builds the production options for the current user.
func Defaults(dryRun bool) (Options, error) {
	proc, locks, signal, err := Live(dryRun)
	if err != nil {
		return Options{}, err
	}
	state, err := grok.StateDir()
	if err != nil {
		return Options{}, err
	}
	store, err := grok.StoreDir()
	if err != nil {
		return Options{}, err
	}
	// /proc/<pid>/exe is always the resolved path.
	if resolved, err := filepath.EvalSymlinks(store); err == nil {
		store = resolved
	}
	return Options{DryRun: dryRun, StoreDir: store, StateDir: state, UID: uint32(os.Getuid()), Self: os.Getpid(), Proc: proc, Locks: locks, Signal: signal}, nil
}

// automaticAllowed keeps go test binaries (cron's own tests) from reaping
// the real per-user state; this package's tests call Run on private roots.
var automaticAllowed = func() bool {
	exe, err := os.Executable()
	return err == nil && !strings.HasSuffix(exe, ".test")
}

// Automatic is the cron step. It runs before session housekeeping so an
// orphan can no longer hold the native process scan busy, and it never fails
// the maintenance run over a single leftover: the line says what was skipped.
func Automatic(_ context.Context, cfg *config.Config, w io.Writer) error {
	if cfg == nil || cfg.Engine != config.EngineGrok || cfg.EngineSuspended(config.EngineGrok) || !automaticAllowed() {
		return nil
	}
	o, err := Defaults(false)
	if errors.Is(err, ErrUnsupported) {
		return nil
	}
	if err != nil {
		fmt.Fprintf(w, "reaper grok: skipped (setup: %v)\n", err)
		return nil
	}
	r, err := Run(o)
	if err != nil {
		fmt.Fprintf(w, "reaper grok: skipped (process scan: %v)\n", err)
		return err
	}
	fmt.Fprintln(w, r.Summary())
	return nil
}

// Preview is the read-only dry run used by `cgx doctor`.
func Preview() (Result, error) {
	o, err := Defaults(true)
	if err != nil {
		return Result{}, err
	}
	return Run(o)
}

// Command serves `cxx housekeeping reap [--dry-run] [--json]`. suspended is
// the fleet master switch for Grok; a live reap honours it, a dry run does not
// change anything and always reports.
func Command(dryRun, jsonOut, suspended bool, stdout, stderr io.Writer) int {
	if suspended && !dryRun {
		fmt.Fprintln(stdout, "reaper grok: suspended (fleet master switch off)")
		return 0
	}
	o, err := Defaults(dryRun)
	if err != nil {
		fmt.Fprintln(stderr, "reaper grok:", err)
		return 1
	}
	r, err := Run(o)
	if err != nil {
		fmt.Fprintln(stderr, "reaper grok:", err)
		return 1
	}
	if jsonOut {
		_ = json.NewEncoder(stdout).Encode(r)
	} else {
		for _, line := range r.Details() {
			fmt.Fprintln(stdout, "  "+line)
		}
		fmt.Fprintln(stdout, r.Summary())
	}
	for _, it := range r.Items {
		if it.Action == "failed" {
			return 1
		}
	}
	return 0
}
