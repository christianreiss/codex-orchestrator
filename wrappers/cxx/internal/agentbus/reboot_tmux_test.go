package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/rebootresume"
	"github.com/google/uuid"
)

func TestRebootTransportUsesCurrentUserPath(t *testing.T) {
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	if got := rebootTransport(); got != "headless" {
		t.Fatalf("missing tmux selected %s", got)
	}
	if err := os.WriteFile(filepath.Join(bin, "tmux"), []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if got := rebootTransport(); got != "tmux" {
		t.Fatalf("installed tmux selected %s", got)
	}
}

func tmuxFixture(t *testing.T, engine string) (rebootresume.Record, string) {
	t.Helper()
	tmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux unavailable: live terminal acceptance skipped")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("GROK_HOME", filepath.Join(home, ".grok"))
	t.Setenv("CXX_TEST_REBOOT_TMUX", "1")
	t.Setenv("TMUX", "")
	t.Setenv("TMUX_PANE", "")
	cwd := filepath.Join(home, "repo's space")
	if err = os.Mkdir(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CXX_TEST_REBOOT_DIR", cwd)
	oldCall := rebootContinuationCall
	t.Cleanup(func() { rebootContinuationCall = oldCall })
	rebootContinuationCall = func(_ context.Context, _, operation string, body any, _ any) error {
		if operation != "finish" {
			t.Errorf("unexpected parent API operation: %s", operation)
		}
		raw, _ := json.Marshal(body)
		return os.WriteFile(filepath.Join(cwd, "finish.json"), raw, 0600)
	}
	boot, err := rebootBootID()
	if err != nil {
		t.Skip("Linux boot ID unavailable")
	}
	r := rebootresume.Record{ID: uuid.NewString(), Engine: engine, NativeID: uuid.NewString(), SessionID: uuid.NewString(), Address: "agent:" + uuid.NewString(), BootID: uuid.NewString(), ResumeBootID: boot, Reason: "test", Continuation: "UNIQUE-CHECKPOINT\nquotes: ' ` $()", UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Home: home, Cwd: cwd, Executable: filepath.Join(cwd, "fake cxx"), ExecutionMode: "tmux"}
	var transcript string
	switch engine {
	case "codex":
		transcript = filepath.Join(home, ".codex", "sessions", "rollout-"+r.NativeID+".jsonl")
	case "claude":
		transcript = filepath.Join(home, ".claude", "projects", "test", r.NativeID+".jsonl")
	case "grok":
		transcript = filepath.Join(home, ".grok", "sessions", "test", r.NativeID, "summary.json")
	}
	if err = os.MkdirAll(filepath.Dir(transcript), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(transcript, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	testExe, _ := os.Executable()
	script := "#!/bin/sh\nif [ \"$1\" = reboot ]; then exec " + rebootShellQuote(testExe) + " -test.run=^TestRebootTmuxHelper$ -- \"$3\"; fi\n" + `
test -t 0 && test -t 1 && test -t 2 || exit 91
printf '%s\n' "$@" > "$CXX_TEST_REBOOT_DIR/args"
pwd > "$CXX_TEST_REBOOT_DIR/cwd"
printf '%s\n' "$CXX_REBOOT_REQUEST_ID" "$CXX_REBOOT_WRITER_ID" "$CXX_AGENT_MESSAGING_UPSTREAM_SESSION_ID" > "$CXX_TEST_REBOOT_DIR/identity"
trap 'exit 0' INT TERM
if [ "$CXX_TEST_REBOOT_DESCENDANT" = 1 ]; then
  sleep 60 &
  printf '%s\n' "$!" > "$CXX_TEST_REBOOT_DIR/descendant"
fi
touch "$CXX_TEST_REBOOT_DIR/ready"
IFS= read -r response
printf '%s\n' "$response" > "$CXX_TEST_REBOOT_DIR/input"
printf 'Terminal input received: %s\n' "$response"
printf '{"content":"done","task_result":{"status":"succeeded","summary":"do not parse TUI"}}\n'
`
	if err = os.WriteFile(r.Executable, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = exec.Command(tmux, "-L", rebootTmuxSession(r), "kill-server").Run() })
	return r, tmux
}

// Runs only inside the tmux pane; the API double never contacts the fleet.
func TestRebootTmuxHelper(t *testing.T) {
	if os.Getenv("CXX_TEST_REBOOT_TMUX") != "1" {
		return
	}
	dir := os.Getenv("CXX_TEST_REBOOT_DIR")
	rebootContinuationCall = func(_ context.Context, _, operation string, body any, out any) error {
		switch operation {
		case "observe":
			_, err := os.Stat(filepath.Join(dir, "stop"))
			raw, _ := json.Marshal(map[string]bool{"stop_requested": err == nil})
			return json.Unmarshal(raw, out)
		case "finish":
			raw, _ := json.Marshal(body)
			return os.WriteFile(filepath.Join(dir, "finish.json"), raw, 0600)
		default:
			t.Fatalf("unexpected API operation: %s", operation)
			return nil
		}
	}
	// A requested stop is expected to produce a failed result, written by the
	// real interactive helper. Do not replace it with go test's exit status.
	_ = runRebootInteractive(os.Args[len(os.Args)-1])
}

func waitRebootFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}

func TestRebootTmuxInteractiveTerminalAndCompletion(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			r, tmux := tmuxFixture(t, engine)
			var output bytes.Buffer
			done := make(chan error, 1)
			go func() {
				done <- runRebootTmux(r, map[string]any{"message_ids": []string{"original-work"}}, tmux, &output, &output)
			}()
			waitRebootFile(t, filepath.Join(r.Cwd, "ready"))
			select {
			case err := <-done:
				t.Fatalf("detached start was reported as completion: %v", err)
			default:
			}
			name := rebootTmuxSession(r)
			// Attach a real client with a PTY, then detach it. The provider must
			// survive and remain ready for subsequent input from another client.
			attachCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			attach := exec.CommandContext(attachCtx, "script", "-q", "-c", rebootTmuxAttach(r), "/dev/null")
			var attachOutput bytes.Buffer
			attach.Stdout, attach.Stderr = &attachOutput, &attachOutput
			clientInput, clientWriter := io.Pipe()
			defer clientInput.Close()
			defer clientWriter.Close()
			attach.Stdin = clientInput
			attach.WaitDelay = time.Second
			attach.Env = append(os.Environ(), "TERM=xterm-256color")
			if err := attach.Start(); err != nil {
				t.Fatal(err)
			}
			attached := false
			for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
				clients, _ := exec.Command(tmux, "-L", name, "list-clients", "-t", name).Output()
				if len(bytes.TrimSpace(clients)) > 0 {
					attached = true
					break
				}
				time.Sleep(25 * time.Millisecond)
			}
			if !attached {
				cancel()
				_ = clientWriter.Close()
				_ = attach.Wait()
				t.Fatalf("interactive tmux client did not attach: %s", attachOutput.String())
			}
			if err := exec.CommandContext(attachCtx, tmux, "-L", name, "detach-client", "-s", name).Run(); err != nil {
				t.Fatal(err)
			}
			_ = clientWriter.Close()
			if err := attach.Wait(); err != nil {
				t.Fatalf("client did not detach cleanly: %v", err)
			}
			if err := exec.Command(tmux, "-L", name, "send-keys", "-t", name, "interactive-input", "Enter").Run(); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("resume failed: %v\n%s", err, output.String())
				}
			case <-time.After(10 * time.Second):
				t.Fatal("supervisor did not complete")
			}
			args, _ := os.ReadFile(filepath.Join(r.Cwd, "args"))
			if strings.Count(string(args), "UNIQUE-CHECKPOINT") != 1 || !strings.Contains(string(args), r.NativeID) || !strings.Contains(string(args), "original-work") || strings.Contains(string(args), "--prompt-file") {
				t.Fatalf("interactive arguments lost checkpoint/identity: %s", args)
			}
			identity, _ := os.ReadFile(filepath.Join(r.Cwd, "identity"))
			if string(identity) != r.ID+"\n"+r.NativeID+"\n"+r.NativeID+"\n" {
				t.Fatalf("identity changed: %s", identity)
			}
			input, _ := os.ReadFile(filepath.Join(r.Cwd, "input"))
			if string(input) != "interactive-input\n" || !strings.Contains(output.String(), "Terminal input received: interactive-input") {
				t.Fatalf("TTY/logging failed: input=%q output=%s", input, output.String())
			}
			finish, _ := os.ReadFile(filepath.Join(r.Cwd, "finish.json"))
			if strings.Contains(string(finish), "task_result") || !strings.Contains(string(finish), `"failed":false`) {
				t.Fatalf("terminal output was mistaken for a work receipt: %s", finish)
			}
		})
	}
}

func TestRebootTmuxRemoteStop(t *testing.T) {
	t.Setenv("CXX_TEST_REBOOT_DESCENDANT", "1")
	r, tmux := tmuxFixture(t, "codex")
	name := rebootTmuxSession(r)
	// A sibling session in this test-owned server must survive the stop/cleanup.
	if err := exec.Command(tmux, "-L", name, "-f", "/dev/null", "new-session", "-d", "-s", "unrelated", "sleep 60").Run(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- runRebootTmux(r, nil, tmux, io.Discard, io.Discard) }()
	waitRebootFile(t, filepath.Join(r.Cwd, "ready"))
	if err := os.WriteFile(filepath.Join(r.Cwd, "stop"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "operator stopped") {
			t.Fatalf("stop result: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("remote stop did not terminate the native process")
	}
	if err := exec.Command(tmux, "-L", name, "has-session", "-t", "unrelated").Run(); err != nil {
		t.Fatal("stop removed unrelated tmux session")
	}
	pid, err := os.ReadFile(filepath.Join(r.Cwd, "descendant"))
	if err != nil {
		t.Fatal(err)
	}
	stat, err := os.ReadFile("/proc/" + strings.TrimSpace(string(pid)) + "/stat")
	if err == nil && !strings.Contains(string(stat), ") Z ") {
		t.Fatalf("owned descendant survived stop: %s", stat)
	}
}

func TestRebootTmuxStartupFailureCannotFallback(t *testing.T) {
	r, _ := tmuxFixture(t, "codex")
	bin := filepath.Join(r.Cwd, "broken tmux")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 42\n"), 0700); err != nil {
		t.Fatal(err)
	}
	old := rebootContinuationCall
	defer func() { rebootContinuationCall = old }()
	finishes := 0
	rebootContinuationCall = func(_ context.Context, _, op string, _ any, _ any) error {
		if op != "finish" {
			t.Fatalf("unexpected operation: %s", op)
		}
		finishes++
		return nil
	}
	err := runRebootTmux(r, nil, bin, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "exit status 42") || finishes != 1 {
		t.Fatalf("startup result=%v finishes=%d", err, finishes)
	}
	if _, err := os.Stat(filepath.Join(r.Cwd, "ready")); !os.IsNotExist(err) {
		t.Fatal("native was started after tmux failure")
	}
}

func TestRebootTmuxLostPaneFailsWithoutNativeRetry(t *testing.T) {
	r, tmux := tmuxFixture(t, "codex")
	done := make(chan error, 1)
	go func() { done <- runRebootTmux(r, nil, tmux, io.Discard, io.Discard) }()
	waitRebootFile(t, filepath.Join(r.Cwd, "ready"))
	if err := exec.Command(tmux, "-L", rebootTmuxSession(r), "kill-session", "-t", rebootTmuxSession(r)).Run(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "without supervisor result") {
			t.Fatalf("lost pane result: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("lost pane was not detected")
	}
	finish, _ := os.ReadFile(filepath.Join(r.Cwd, "finish.json"))
	if !strings.Contains(string(finish), `"failed":true`) {
		t.Fatalf("lost pane did not fail the handoff: %s", finish)
	}
}

func TestRebootTmuxCollisionPreservesExistingSession(t *testing.T) {
	r, tmux := tmuxFixture(t, "codex")
	name := rebootTmuxSession(r)
	if err := exec.Command(tmux, "-L", name, "-f", "/dev/null", "new-session", "-d", "-s", name, "sleep 60").Run(); err != nil {
		t.Fatal(err)
	}
	if err := runRebootTmux(r, nil, tmux, io.Discard, io.Discard); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("collision result: %v", err)
	}
	if err := exec.Command(tmux, "-L", name, "has-session", "-t", name).Run(); err != nil {
		t.Fatal("existing session was stopped")
	}
	if _, err := os.Stat(filepath.Join(r.Cwd, "finish.json")); !os.IsNotExist(err) {
		t.Fatal("collision finished a pre-existing handoff")
	}
}
