package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativewriter"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/rebootresume"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionguard"
)

var requestRebootAdapter = requestReboot

func rebootExecutable(id string) string {
	return filepath.Join("/usr/local/libexec/cxx-reboot-resume", id, "cxx")
}

func rebootBootID() (string, error) {
	b, e := os.ReadFile("/proc/sys/kernel/random/boot_id")
	return strings.TrimSpace(string(b)), e
}

func RunRebootCommand(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if err := runRebootCommand(args, stdin, stdout, stderr); err != nil {
		fmt.Fprintln(stderr, "cxx reboot:", err)
		return 1
	}
	return 0
}
func runRebootCommand(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if len(args) > 0 && (args[0] == "help" || args[0] == "--help") {
		fmt.Fprintln(stdout, "cxx reboot --request-id UUID --reason TEXT --stdin\ncxx reboot status [--id UUID]\ncxx reboot disarm --id UUID\nLinux, root or passwordless sudo. One job per host; consumed sessions cannot rearm. No automatic retry after native startup.")
		return nil
	}
	if runtime.GOOS != "linux" {
		return errors.New("planned reboot requires Linux")
	}
	if len(args) > 0 && strings.HasPrefix(args[0], "_") {
		return rebootInternal(args, stdin, stdout, stderr)
	}
	if len(args) > 0 && (args[0] == "status" || args[0] == "disarm") {
		f := newFlagSet("cxx reboot "+args[0], stderr)
		id := f.String("id", "", "request UUID")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 {
			return errors.New("unexpected positional arguments")
		}
		if args[0] == "disarm" && *id == "" {
			return errors.New("disarm requires --id")
		}
		_, err := rebootRoot(context.Background(), "_"+args[0], *id, nil, stdout, stderr)
		if err == nil && args[0] == "disarm" {
			err = rebootHostCall(context.Background(), "", "disarm", map[string]any{"request_id": *id}, nil)
		}
		return err
	}
	f := newFlagSet("cxx reboot", stderr)
	id := f.String("request-id", "", "stable request UUID")
	reason := f.String("reason", "", "reason")
	fromStdin := f.Bool("stdin", false, "read continuation")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	continuation, err := readMessageBody(stdin, *fromStdin)
	if err != nil {
		return err
	}
	client, err := sessionClientFromEnv(30 * time.Second)
	if err != nil {
		return err
	}
	out, err := requestReboot(context.Background(), client, map[string]any{"request_id": *id, "reason": *reason, "continuation": continuation}, stderr)
	if err != nil {
		return err
	}
	return writeJSON(stdout, out)
}

func requestReboot(ctx context.Context, client *sessionClient, args map[string]any, stderr io.Writer) (map[string]any, error) {
	if runtime.GOOS != "linux" {
		return nil, errors.New("planned reboot requires Linux")
	}
	boot, err := rebootBootID()
	if err != nil {
		return nil, err
	}
	// Check elevation and cron before reserving anything at the server.
	if _, err = rebootRoot(ctx, "_check", "", nil, io.Discard, stderr); err != nil {
		return nil, err
	}
	body := map[string]any{"request_id": stringArg(args, "request_id"), "reason": stringArg(args, "reason"), "continuation": stringArg(args, "continuation"), "boot_id": boot}
	var r rebootresume.Record
	if err = client.post(ctx, "reboot/prepare", body, &r); err != nil {
		return nil, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	r.UID, r.GID, r.Home = uint32(os.Getuid()), uint32(os.Getgid()), home
	r.Executable = rebootExecutable(r.ID)
	cleanup := func(cause error) error {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, localErr := rebootRoot(cleanupCtx, "_disarm", r.ID, nil, io.Discard, stderr)
		remoteErr := client.post(cleanupCtx, "reboot/disarm", map[string]any{"request_id": r.ID}, nil)
		return errors.Join(cause, localErr, remoteErr)
	}
	r.Environment, err = rebootEnvironment(r.Engine)
	if err != nil {
		return nil, cleanup(err)
	}
	raw, err := json.Marshal(r)
	if err != nil {
		return nil, err
	}
	if _, err = rebootRoot(ctx, "_stage", r.ID, raw, io.Discard, stderr); err != nil {
		return nil, cleanup(err)
	}
	var out map[string]any
	if err = client.post(ctx, "reboot/arm", map[string]any{"request_id": r.ID}, &out); err != nil {
		return nil, cleanup(err)
	}
	if _, err = rebootRoot(ctx, "_issue", r.ID, nil, io.Discard, stderr); err != nil {
		return nil, err
	}
	return out, nil
}

func rebootEnvironment(engine string) ([]string, error) {
	var env []string
	// Exclude bridge tokens, provider credentials and old receiver sockets.
	// Normal signed-config/auth setup runs anew after the reboot.
	for _, key := range []string{"PATH", "LANG", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CDX_CONFIG_PATH", "CLX_CONFIG_PATH", "CGX_CONFIG_PATH"} {
		v, ok := os.LookupEnv(key)
		if key == "GROK_HOME" && engine == "grok" {
			v, ok = os.LookupEnv("CXX_GROK_BASE_HOME")
			if !ok || !filepath.IsAbs(v) {
				return nil, errors.New("durable Grok home unavailable; start a current managed wrapper before requesting reboot")
			}
		}
		if ok {
			env = append(env, key+"="+v)
		}
	}
	return env, nil
}

func rebootRoot(ctx context.Context, action, id string, body []byte, stdout, stderr io.Writer) ([]byte, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	argv := []string{"reboot", action}
	if id != "" {
		argv = append(argv, "--id", id)
	}
	if os.Geteuid() != 0 {
		argv = append([]string{"-n", "--", exe}, argv...)
		exe = "sudo"
	}
	cmd := exec.CommandContext(ctx, exe, argv...)
	cmd.Stdin = bytes.NewReader(body)
	var output bytes.Buffer
	cmd.Stdout = io.MultiWriter(stdout, &output)
	cmd.Stderr = stderr
	err = cmd.Run()
	return output.Bytes(), err
}

func rebootInternal(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if args[0] == "_resume" {
		var r rebootresume.Record
		if err := json.NewDecoder(io.LimitReader(stdin, 65536)).Decode(&r); err != nil {
			return err
		}
		return resumeAfterReboot(r, stdout, stderr)
	}
	if os.Geteuid() != 0 {
		return errors.New("root helper requires root or passwordless sudo")
	}
	if args[0] == "_check" {
		if _, err := exec.LookPath("systemctl"); err != nil {
			return err
		}
		if err := exec.Command("systemctl", "is-active", "--quiet", "cron.service").Run(); err != nil {
			if e := exec.Command("systemctl", "is-active", "--quiet", "crond.service").Run(); e != nil {
				return errors.New("an active cron/crond service is required")
			}
		}
		return nil
	}
	f := newFlagSet("cxx reboot internal", stderr)
	id := f.String("id", "", "request UUID")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("unexpected arguments")
	}
	j := rebootresume.System()
	lock, err := j.Lock()
	if err != nil {
		return err
	}
	defer lock.Release()
	switch args[0] {
	case "_status":
		if *id != "" {
			r, err := j.Read(*id)
			if err != nil {
				return err
			}
			return json.NewEncoder(stdout).Encode(r)
		}
		records, err := j.List()
		if err != nil {
			return err
		}
		return json.NewEncoder(stdout).Encode(records)
	case "_stage":
		var r rebootresume.Record
		if err := json.NewDecoder(io.LimitReader(stdin, 65536)).Decode(&r); err != nil {
			return err
		}
		if r.ID != *id {
			return errors.New("request ID mismatch")
		}
		if err := r.Validate(); err != nil {
			return err
		}
		if r.Executable != rebootExecutable(r.ID) {
			return errors.New("unexpected frozen executable path")
		}
		if _, err := j.Read(r.ID); err == nil {
			return j.Stage(&r)
		}
		if err := os.MkdirAll(filepath.Dir(r.Executable), 0755); err != nil {
			return err
		}
		// Freeze this version in a root-owned executable, independent of subsequent
		// per-user wrapper updates. Atomic rename keeps an existing job intact.
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		if exe != r.Executable {
			b, err := os.ReadFile(exe)
			if err != nil {
				return err
			}
			tmp, err := os.CreateTemp(filepath.Dir(r.Executable), ".cxx-*")
			if err != nil {
				return err
			}
			defer os.Remove(tmp.Name())
			defer tmp.Close()
			if _, err = tmp.Write(b); err != nil {
				return err
			}
			if err = tmp.Chmod(0755); err != nil {
				return err
			}
			if err = tmp.Sync(); err != nil {
				return err
			}
			if err = tmp.Close(); err != nil {
				return err
			}
			if err = os.Rename(tmp.Name(), r.Executable); err != nil {
				return err
			}
			// The resumed user cannot repair this root-owned layout. Freeze the
			// relative persona aliases too, before normal peer reconciliation runs.
			if _, err = layout.EnsureAliases(context.Background(), r.Executable, []string{"codex", "claude", "grok"}); err != nil {
				return err
			}
			directory, err := os.Open(filepath.Dir(r.Executable))
			if err != nil {
				return err
			}
			err = directory.Sync()
			directory.Close()
			if err != nil {
				return err
			}
		}
		return j.Stage(&r)
	case "_disarm":
		r, err := j.Read(*id)
		if err != nil {
			return err
		}
		if r.State == "disarmed" {
			return j.RemoveCron(r)
		}
		if r.State != "prepared" && r.State != "armed" {
			return errors.New("only an unconsumed job can be disarmed")
		}
		r.State = "disarmed"
		if err = j.Save(r); err != nil {
			return err
		}
		return j.RemoveCron(r)
	case "_issue":
		r, err := j.Read(*id)
		if err != nil {
			return err
		}
		if r.State == "armed" {
			if r.Error != "" {
				return errors.New(r.Error)
			}
			return nil
		}
		if r.State != "prepared" {
			return errors.New("job is not prepared")
		}
		boot, err := rebootBootID()
		if err != nil {
			return err
		}
		if boot != r.BootID {
			return errors.New("host already rebooted")
		}
		r.State = "armed"
		if err = j.Save(r); err != nil {
			return err
		}
		// Persist issuance BEFORE calling systemctl. A failed/ambiguous command is
		// not repeated by a retry of the request.
		err = exec.Command("systemctl", "reboot", "--no-block").Run()
		if err != nil {
			r.Error = "reboot command failed; inspect host before manual intervention"
			_ = j.Save(r)
		}
		return err
	case "_boot":
		boot, err := rebootBootID()
		if err != nil {
			return err
		}
		r, err := j.Consume(*id, boot)
		if err != nil || r == nil {
			return err
		}
		r.State = "running"
		if err = j.Save(r); err != nil {
			return err
		}
		// Never keep the host lock throughout model execution. The consumed journal
		// and server binding fence additional attempts, and status stays available.
		if err = lock.Release(); err != nil {
			return err
		}
		raw, err := json.Marshal(r)
		if err != nil {
			return err
		}
		cmd := exec.Command(r.Executable, "reboot", "_resume")
		cmd.Dir = r.Cwd
		cmd.Stdin = bytes.NewReader(raw)
		cmd.Env = append([]string{"HOME=" + r.Home}, r.Environment...)
		u, err := user.LookupId(strconv.FormatUint(uint64(r.UID), 10))
		if err != nil {
			return err
		}
		groups, err := u.GroupIds()
		if err != nil {
			return err
		}
		gids := []uint32{}
		for _, g := range groups {
			n, e := strconv.ParseUint(g, 10, 32)
			if e != nil {
				return e
			}
			gids = append(gids, uint32(n))
		}
		cmd.Env = append(cmd.Env, "USER="+u.Username, "LOGNAME="+u.Username)
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: r.UID, Gid: r.GID, Groups: gids}}
		log, err := os.OpenFile(filepath.Join(j.Dir, r.ID+".log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			return err
		}
		defer log.Close()
		cmd.Stdout, cmd.Stderr = log, log
		err = cmd.Run()
		r.State = "finished"
		if err != nil {
			r.State = "failed"
			r.Error = err.Error()
		}
		lease, e := j.Lock()
		if e != nil {
			return e
		}
		defer lease.Release()
		if e = j.Save(r); e != nil {
			return e
		}
		return err
	default:
		return errors.New("unknown internal reboot operation")
	}
}

func resumeAfterReboot(r rebootresume.Record, stdout, stderr io.Writer) error {
	if err := r.Validate(); err != nil {
		return err
	}
	if uint32(os.Getuid()) != r.UID {
		return errors.New("resume user mismatch")
	}
	boot, err := rebootBootID()
	if err != nil {
		return err
	}
	if boot != r.ResumeBootID || boot == r.BootID {
		return errors.New("resume boot mismatch")
	}

	var readiness map[string]any
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	err = waitRebootReady(ctx, 5*time.Second, func(ctx context.Context) error {
		return rebootHostCall(ctx, r.Engine, "ready", map[string]any{"request_id": r.ID, "boot_id": r.ResumeBootID}, &readiness)
	})
	if err != nil {
		return err
	}
	return runRebootContinuation(r, readiness, stdout, stderr)
}

// During boot IPv6 can become usable before the host's bound IPv4 route.
// Readiness is read-only: retrying that IP mismatch within the existing deadline
// never retries native execution or weakens the server's binding policy.
func waitRebootReady(ctx context.Context, interval time.Duration, probe func(context.Context) error) error {
	for {
		err := probe(ctx)
		if err == nil {
			return nil
		}
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.Status >= 400 && apiErr.Status < 500 && apiErr.Status != 429 && apiErr.Code != "ip_mismatch" {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("reboot readiness deadline: %w", err)
		case <-time.After(interval):
		}
	}
}

func runRebootContinuation(r rebootresume.Record, readiness map[string]any, stdout, stderr io.Writer) error {
	guard, err := sessionguard.Launch(r.Engine)
	if err != nil {
		return err
	}
	defer guard.Release()
	lock, err := nativewriter.Acquire(r.Engine, r.NativeID)
	if err != nil {
		return err
	}
	defer lock.Release()
	if err = checkRebootTranscript(r.Engine, r.NativeID); err != nil {
		return err
	}
	args := nativeArgs(r.Engine, r.NativeID)
	prompt := "Planned host reboot completed. This one-use reboot request " + r.ID + " is consumed. Do not reboot or rearm again. Call agent_self to refresh your launch identity, then continue the SAME task from this checkpoint. Preserve original work message IDs and report their results explicitly.\n\n" + r.Continuation
	ids, _ := json.Marshal(readiness["message_ids"])
	prompt += "\nTransferred original work message IDs: " + string(ids) + "\n" + rebootOutputInstruction
	if r.Engine == "grok" {
		f, err := os.CreateTemp("", "cxx-reboot-prompt-*.txt")
		if err != nil {
			return err
		}
		defer os.Remove(f.Name())
		if _, err = f.WriteString(prompt); err != nil {
			f.Close()
			return err
		}
		if err = f.Close(); err != nil {
			return err
		}
		args = append(args, "--prompt-file", f.Name())
	}
	cmd := exec.Command(r.Executable, args...)
	cmd.Dir = r.Cwd
	cmd.Stdin = strings.NewReader(prompt)
	if r.Engine == "grok" {
		cmd.Stdin = nil
	}
	var output tailBuffer
	output.limit = workerOutputLimit
	cmd.Stdout, cmd.Stderr = io.MultiWriter(stdout, &output), stderr
	prepareDaemonProcess(cmd)
	cmd.Env = append(os.Environ(), "CXX_REBOOT_REQUEST_ID="+r.ID, "CXX_REBOOT_BOOT_ID="+r.ResumeBootID, "CXX_REBOOT_WRITER_ID="+r.NativeID, "CXX_AGENT_MESSAGING_UPSTREAM_SESSION_ID="+r.NativeID)

	runErr := cmd.Start()
	if runErr == nil {
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
	waitLoop:
		for {
			select {
			case runErr = <-done:
				break waitLoop
			case <-ticker.C:
				var state struct {
					Stop bool `json:"stop_requested"`
				}
				checkCtx, checkCancel := context.WithTimeout(context.Background(), 10*time.Second)
				e := rebootHostCall(checkCtx, r.Engine, "observe", map[string]any{"request_id": r.ID}, &state)
				checkCancel()
				if e == nil && state.Stop {
					stopDaemonProcess(cmd, done)
					runErr = errors.New("operator stopped reboot continuation")
					break waitLoop
				}
			}
		}
	}
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer finishCancel()
	reply, nativeID := parseNativeOutput(r.Engine, output.Bytes())
	_, report := parseTaskOutput(reply)
	body := map[string]any{"request_id": r.ID, "failed": runErr != nil}
	if report != nil && runErr == nil && nativeID == r.NativeID {
		body["task_result"] = report
	}
	finishErr := rebootHostCall(finishCtx, r.Engine, "finish", body, nil)
	return errors.Join(runErr, finishErr)
}

const rebootOutputInstruction = "For each transferred Peer or Wake task, store its explicit result with agent_task_result or agent_reply using the original message ID. Answer a transferred Portal instruction with agent_receiver_reply and its original message ID. The reboot supervisor does not store these receipts for you. Then report the overall continuation outcome as JSON: {\"content\":\"human response\",\"task_result\":{\"status\":\"succeeded|failed|blocked|unknown\",\"summary\":\"plain result (maximum 4096 UTF-8 bytes)\"}}. A successful reboot alone is not proof that the original task succeeded.\n"

func rebootHostCall(ctx context.Context, engine, operation string, body any, out any) error {
	configs, cfg, err := loadMessagingConfigs()
	if err != nil {
		return err
	}
	if engine != "" {
		cfg = configs[engine]
	}
	if cfg == nil {
		return errors.New("signed messaging configuration unavailable")
	}
	client, err := newRelayClient(cfg)
	if err != nil {
		return err
	}
	return doJSON(ctx, client.http, client.baseURL, http.MethodPost, "/host/reboot-handoffs/"+operation, body, map[string]string{"X-API-Key": client.apiKey}, out)
}

func checkRebootTranscript(engine, id string) error {
	root, err := sessionguard.Root(engine)
	if err != nil {
		return err
	}
	found := false
	var paths []string
	switch engine {
	case "codex":
		for _, sub := range []string{"sessions", "archived_sessions"} {
			e := filepath.WalkDir(filepath.Join(root, sub), func(path string, d fs.DirEntry, e error) error {
				if os.IsNotExist(e) {
					return nil
				}
				if e != nil {
					return e
				}
				if d.Type()&os.ModeSymlink != 0 {
					return errors.New("symlink in native session tree")
				}
				if !d.IsDir() && strings.HasSuffix(d.Name(), "-"+id+".jsonl") {
					paths = append(paths, path)
				}
				return nil
			})
			if e != nil {
				return e
			}
		}
	case "claude":
		paths, err = filepath.Glob(filepath.Join(root, "projects", "*", id+".jsonl"))
	case "grok":
		paths, err = filepath.Glob(filepath.Join(root, "sessions", "*", id, "summary.json"))
	}
	if err != nil {
		return err
	}
	for _, p := range paths {
		s, e := os.Lstat(p)
		if e != nil {
			return e
		}
		if s.Mode().IsRegular() && s.Size() > 0 {
			found = true
		}
	}
	if !found {
		return errors.New("native transcript missing; fresh start and retry are forbidden")
	}
	return nil
}

// Reconstruct accepted work without injecting its original prompt again. The
// first tool call waits for this restore, including a result/reply immediately
// after reboot. Only the elected MCP owner keeps renewal goroutines.
func (t *channelTracker) restoreReboot(ctx context.Context) error {
	if os.Getenv("CXX_REBOOT_REQUEST_ID") == "" {
		return nil
	}
	t.rebootMu.Lock()
	defer t.rebootMu.Unlock()
	if t.rebootRestored {
		return nil
	}
	var restored struct {
		Peer   []map[string]any `json:"peer"`
		Portal map[string]any   `json:"portal"`
	}
	if err := t.client.post(ctx, "reboot/restore", map[string]any{}, &restored); err != nil {
		return err
	}
	for _, p := range restored.Peer {
		t.track(ctx, stringArg(p, "message_id"), stringArg(p, "claim_id"), p)
	}
	if restored.Portal != nil {
		if t.receiver == nil {
			return errors.New("reboot Portal handoff requires the native receiver")
		}
		t.receiver.mu.Lock()
		t.receiver.pendingPortal = restored.Portal
		t.receiver.mu.Unlock()
	}
	t.rebootRestored = true
	return nil
}
