package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/rebootresume"
)

func rebootTransport() string {
	if _, err := exec.LookPath("tmux"); err == nil {
		return "tmux"
	}
	return "headless"
}

func rebootTmuxSession(r rebootresume.Record) string { return "cxx-reboot-" + r.ID }

// Each request has its own config-free tmux server. Existing user servers must
// neither lend stale environment/auth nor influence exit/respawn behavior.
func rebootTmuxAttach(r rebootresume.Record) string {
	name := rebootTmuxSession(r)
	return "tmux -L " + name + " attach -t " + name
}

func rebootInteractiveArgs(engine, id, prompt string) []string {
	return []string{engine, "--skip-boot", "resume", id, prompt}
}

type rebootTmuxHandoff struct {
	Record    rebootresume.Record `json:"record"`
	Readiness map[string]any      `json:"readiness"`
}

type rebootTmuxResult struct {
	Error string `json:"error,omitempty"`
}

func rebootShellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

// tmux setup/lost-supervisor failures are terminal, never another native start.
func finishLostReboot(r rebootresume.Record, cause error) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := rebootContinuationCall(ctx, r.Engine, "finish", map[string]any{"request_id": r.ID, "failed": true}, nil)
	return errors.Join(cause, err)
}

func runRebootTmux(r rebootresume.Record, readiness map[string]any, tmux string, stdout, stderr io.Writer) error {
	r.ExecutionMode = "tmux"
	name := rebootTmuxSession(r)
	dir, err := os.MkdirTemp("", "cxx-reboot-tmux-*")
	if err != nil {
		return finishLostReboot(r, err)
	}
	defer os.RemoveAll(dir)
	handoff := filepath.Join(dir, "handoff.json")
	raw, err := json.Marshal(rebootTmuxHandoff{Record: r, Readiness: readiness})
	if err != nil {
		return finishLostReboot(r, err)
	}
	if err = os.WriteFile(handoff, raw, 0600); err != nil {
		return finishLostReboot(r, err)
	}
	logPath := filepath.Join(dir, "terminal.log")
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return finishLostReboot(r, err)
	}
	defer log.Close()
	command := func(out, diagnostic io.Writer, args ...string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, tmux, append([]string{"-L", name, "-f", "/dev/null"}, args...)...)
		cmd.WaitDelay = time.Second
		cmd.Stdout, cmd.Stderr = out, diagnostic
		return cmd.Run()
	}
	// The pane waits for a gate; install logging before any native output/start.
	shell := "exec " + rebootShellQuote(r.Executable) + " reboot _interactive " + rebootShellQuote(handoff)
	args := []string{"new-session", "-d", "-s", name, "-c", r.Cwd, "-x", "120", "-y", "40"}
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "TMUX=") && !strings.HasPrefix(value, "TMUX_PANE=") {
			args = append(args, "-e", value)
		}
	}
	args = append(args, shell)
	if command(io.Discard, io.Discard, "has-session", "-t", name) == nil {
		return errors.New("tmux continuation session already exists; refusing to replace it")
	}
	if err = command(stdout, stderr, args...); err != nil {
		// Never kill a session we did not successfully create. Removing the
		// private directory revokes any ambiguous pane's native-start gate.
		return finishLostReboot(r, fmt.Errorf("tmux start: %w", err))
	}
	defer func() { _ = command(io.Discard, io.Discard, "kill-session", "-t", name) }()
	pipeDone := filepath.Join(dir, "pipe.done")
	if err = command(io.Discard, stderr, "pipe-pane", "-o", "-t", name+":0.0", "cat >> "+rebootShellQuote(logPath)+" && touch "+rebootShellQuote(pipeDone)); err != nil {
		return finishLostReboot(r, fmt.Errorf("tmux logging: %w", err))
	}
	if err = os.WriteFile(filepath.Join(dir, "go"), nil, 0600); err != nil {
		return finishLostReboot(r, err)
	}
	fmt.Fprintln(stdout, "Interactive reboot continuation:", rebootTmuxAttach(r))
	// Keep the boot journal running until the supervisor exits. Detach merely
	// disconnects a client; pane/server loss without a result is a failure.
	for {
		_, _ = io.Copy(stdout, log)
		if err = command(io.Discard, io.Discard, "has-session", "-t", name); err != nil {
			// Drain pipe-pane before removing its private files.
			for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
				if _, e := os.Stat(pipeDone); e == nil {
					break
				}
				time.Sleep(25 * time.Millisecond)
			}
			_, _ = io.Copy(stdout, log)
			var result rebootTmuxResult
			raw, readErr := os.ReadFile(filepath.Join(dir, "result.json"))
			if readErr != nil {
				return finishLostReboot(r, errors.New("tmux continuation ended without supervisor result"))
			}
			if err = json.Unmarshal(raw, &result); err != nil {
				return finishLostReboot(r, err)
			}
			if result.Error != "" {
				return errors.New(result.Error)
			}
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func runRebootInteractive(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var handoff rebootTmuxHandoff
	if err = json.Unmarshal(raw, &handoff); err != nil {
		return err
	}
	r := handoff.Record
	if err = validateRebootResume(r); err != nil {
		return err
	}
	if r.ExecutionMode != "tmux" {
		return errors.New("interactive handoff requires tmux mode")
	}
	dir := filepath.Dir(path)
	// Bounded setup wait only. The actual interactive session has no idle expiry.
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err = os.Stat(filepath.Join(dir, "go")); err == nil {
			break
		}
		if !errors.Is(err, os.ErrNotExist) || time.Now().After(deadline) {
			return errors.New("tmux setup gate unavailable")
		}
		time.Sleep(25 * time.Millisecond)
	}
	err = runRebootContinuation(r, handoff.Readiness, os.Stdout, os.Stderr)
	result := rebootTmuxResult{}
	if err != nil {
		result.Error = err.Error()
	}
	raw, _ = json.Marshal(result)
	// Publish atomically, after finish has been attempted and before pane exit.
	tmp := filepath.Join(dir, "result.tmp")
	if writeErr := os.WriteFile(tmp, raw, 0600); writeErr != nil {
		return errors.Join(err, writeErr)
	}
	return errors.Join(err, os.Rename(tmp, filepath.Join(dir, "result.json")))
}
