// Package maintenance coalesces cron and launch-triggered upkeep without putting
// network requests or installers on the interactive process's critical path.
package maintenance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

const (
	successInterval = 15 * time.Minute
	retryInterval   = 5 * time.Minute
	queueInterval   = 30 * time.Second
	maxLogBytes     = 4 << 20
)

var (
	ErrBusy   = errors.New("maintenance already running")
	ErrNotDue = errors.New("maintenance is not due")
)

// State contains operational metadata only; config contents and error strings
// (which may contain provider credentials) are deliberately never persisted.
type State struct {
	RequestedUntil time.Time `json:"requested_until,omitempty"`
	StartedAt      time.Time `json:"started_at,omitempty"`
	FinishedAt     time.Time `json:"finished_at,omitempty"`
	NextAttempt    time.Time `json:"next_attempt,omitempty"`
	Outcome        string    `json:"outcome,omitempty"`
}

type Run struct {
	lock  *ipc.Lock
	dir   string
	state State
}

func stateDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cxx"), nil
}

// Begin holds a nonblocking lease for the entire coordinator run. Manual runs
// bypass the cooldown; neither manual nor scheduled runs overlap a live owner.
func Begin(ctx context.Context, due bool) (*Run, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	dir, err := stateDir()
	if err != nil {
		return nil, err
	}
	return beginAt(dir, due, time.Now().UTC())
}

func beginAt(dir string, due bool, now time.Time) (*Run, error) {
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(dir, "maintenance.lock"))
	if errors.Is(err, ipc.ErrHeld) {
		return nil, ErrBusy
	}
	if err != nil {
		return nil, err
	}
	s, err := readState(dir)
	if err != nil {
		_ = lock.Release()
		return nil, err
	}
	if due && inFuture(s.NextAttempt, now, successInterval) {
		_ = lock.Release()
		return nil, ErrNotDue
	}
	s.RequestedUntil = time.Time{}
	s.StartedAt, s.FinishedAt = now, time.Time{}
	s.NextAttempt, s.Outcome = now.Add(retryInterval), "running"
	if err := writeState(dir, s); err != nil {
		_ = lock.Release()
		return nil, err
	}
	return &Run{lock: lock, dir: dir, state: s}, nil
}

func (r *Run) Finish(runErr error) error {
	return r.finishAt(runErr, time.Now().UTC())
}

func (r *Run) finishAt(runErr error, now time.Time) error {
	if r == nil || r.lock == nil {
		return nil
	}
	r.state.FinishedAt = now
	r.state.Outcome, r.state.NextAttempt = "ok", now.Add(successInterval)
	if runErr != nil {
		r.state.Outcome, r.state.NextAttempt = "failed", now.Add(retryInterval)
	}
	err := writeState(r.dir, r.state)
	err = errors.Join(err, r.lock.Release())
	r.lock = nil
	return err
}

// Request queues a detached coordinator, returning after local process creation.
// It never fetches config, probes a CLI, waits on a lock, or waits for the child.
// Both personas share one queue and one coordinator lease in the user's home.
func Request(engine, configPath string) error {
	if os.Getenv("CXX_BACKGROUND_MAINTENANCE") == "0" {
		return nil
	}
	if engine != config.EngineCodex && engine != config.EngineClaude {
		return errors.New("unknown maintenance engine")
	}
	// Unit/integration binaries must never recursively launch their test runner.
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if strings.HasSuffix(exe, ".test") {
		return nil
	}
	dir, err := stateDir()
	if err != nil {
		return err
	}
	env, err := childEnv(engine, configPath, os.Environ())
	if err != nil {
		return err
	}
	return requestAt(dir, time.Now().UTC(), func() error { return spawn(exe, dir, env) })
}

func requestAt(dir string, now time.Time, start func() error) error {
	// The enqueue lock closes the interval between publishing the queue marker
	// and spawning the child; the child takes only the coordinator lock.
	queue, err := ipc.TryAcquireExclusivePath(filepath.Join(dir, "maintenance-queue.lock"))
	if errors.Is(err, ipc.ErrHeld) {
		return nil
	}
	if err != nil {
		return err
	}
	defer queue.Release()
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(dir, "maintenance.lock"))
	if errors.Is(err, ipc.ErrHeld) {
		return nil
	}
	if err != nil {
		return err
	}
	s, err := readState(dir)
	if err != nil {
		_ = lock.Release()
		return err
	}
	if inFuture(s.NextAttempt, now, successInterval) || inFuture(s.RequestedUntil, now, queueInterval) {
		_ = lock.Release()
		return nil
	}
	s.RequestedUntil = now.Add(queueInterval)
	if err = writeState(dir, s); err != nil {
		_ = lock.Release()
		return err
	}
	// Release before Start: a fast child must be able to acquire its lease.
	_ = lock.Release()
	if err = start(); err == nil {
		return nil
	}
	// A spawn failure is retried, but never on every interactive command.
	if lock, lockErr := ipc.TryAcquireExclusivePath(filepath.Join(dir, "maintenance.lock")); lockErr == nil {
		defer lock.Release()
		latest, readErr := readState(dir)
		if readErr == nil && latest.RequestedUntil.Equal(s.RequestedUntil) {
			latest.RequestedUntil = time.Time{}
			latest.Outcome, latest.NextAttempt = "spawn_failed", now.Add(retryInterval)
			_ = writeState(dir, latest)
		}
	}
	return err
}

func inFuture(at, now time.Time, max time.Duration) bool {
	// A backward wall-clock adjustment must not silence maintenance indefinitely.
	return at.After(now) && !at.After(now.Add(max))
}

func readState(dir string) (State, error) {
	var s State
	raw, err := os.ReadFile(filepath.Join(dir, "maintenance.json"))
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	// A truncated/old state file is recoverable; the flock remains authoritative.
	if json.Unmarshal(raw, &s) != nil {
		return State{}, nil
	}
	return s, nil
}

func writeState(dir string, s State) error {
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".maintenance-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(append(raw, '\n')); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(dir, "maintenance.json"))
}

func childEnv(engine, source string, env []string) ([]string, error) {
	if strings.TrimSpace(source) == "" {
		return nil, errors.New("maintenance config path is empty")
	}
	source, err := filepath.Abs(source)
	if err != nil {
		return nil, err
	}
	key := "CDX_CONFIG_PATH"
	if engine == config.EngineClaude {
		key = "CLX_CONFIG_PATH"
	}
	drop := map[string]bool{
		key: true, "CXX_CRON_ENGINE_ONLY": true, "CXX_CRON_COORDINATED": true,
		"CODEX_WRAPPER_RESTART_DEPTH": true, "CLAUDE_WRAPPER_RESTART_DEPTH": true,
		"CODEX_WRAPPER_RESTARTED": true, "CLAUDE_WRAPPER_RESTARTED": true,
		"CODEX_ORCH_PEER_SPAWN":    true,
		"CDX_AUTH_SESSION_HANDOFF": true, "CLX_AUTH_SESSION_HANDOFF": true,
	}
	result := make([]string, 0, len(env)+1)
	for _, item := range env {
		name, value, ok := strings.Cut(item, "=")
		if !ok || drop[name] {
			continue
		}
		// Match each resolver's whitespace semantics before changing directory.
		switch name {
		case "CDX_CONFIG_PATH", "CLX_CONFIG_PATH", "CODEX_HOME", "CDX_CODEX_BIN", "CLX_CLAUDE_BIN", "XDG_CONFIG_HOME":
			value = strings.TrimSpace(value)
		}
		if value != "" && (name == "CDX_CONFIG_PATH" || name == "CLX_CONFIG_PATH" || name == "CODEX_HOME" || name == "XDG_CONFIG_HOME" || name == "HOME" || name == "CDX_CODEX_BIN" || name == "CLX_CLAUDE_BIN") {
			value, err = filepath.Abs(value)
			if err != nil {
				return nil, err
			}
		}
		result = append(result, name+"="+value)
	}
	return append(result, key+"="+source), nil
}

func spawn(exe, dir string, env []string) error {
	logPath := filepath.Join(dir, "cron.log")
	if st, err := os.Lstat(logPath); err == nil && st.Mode().IsRegular() && st.Size() >= maxLogBytes {
		if err := os.Rename(logPath, logPath+".1"); err != nil {
			return fmt.Errorf("rotate maintenance log: %w", err)
		}
	}
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	defer log.Close()
	if err := log.Chmod(0o600); err != nil {
		return err
	}
	cmd := exec.Command(exe, "cron", "run", "--due", "--minimal")
	cmd.Args[0] = "cxx" // Preserve global dispatch even when exe was an alias.
	cmd.Env, cmd.Dir = env, dir
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start background maintenance: %w", err)
	}
	go func() { _ = cmd.Wait() }() // Reap while parent lives; never await upkeep.
	return nil
}
