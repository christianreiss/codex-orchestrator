package rtk

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/buildinfo"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
	"github.com/pelletier/go-toml"
	_ "modernc.org/sqlite"
)

const sessionEnv = "CXX_RTK_SESSION"
const binaryEnv = "CXX_RTK_BINARY"
const awareness = "Command output filtering is enabled for this session. Prefer `rtk <command>` for supported external development commands (git, go test, npm, search). Leave shell builtins, scripts, pipelines, redirections and command substitutions unchanged. Never prefix a command twice. Filtering may omit evidence: use `rtk recall <hash>` when a recall hint is printed, or `rtk bypass <command>` for raw output. Do not rerun a mutating command to recover its output. RTK does not grant permission or change task authorization."

type Session struct {
	Dir    string
	Binary string
	Env    []string
	Args   []string
	Mode   string
	lease  *os.File
}

// Prepare is launch-local: no native or user configuration is edited.
func Prepare(ctx context.Context, cfg *config.Config, args, env []string, home string, w io.Writer, nativeVersions ...string) (_ *Session, retErr error) {
	s := &Session{Args: append([]string{}, args...), Env: append([]string{}, env...)}
	nativeVersion := ""
	if len(nativeVersions) > 0 {
		nativeVersion = nativeVersions[0]
	}
	defer func() {
		if retErr != nil {
			report(ctx, cfg, false, errorCode(retErr), "", nativeVersion)
		}
	}()
	disabled := false
	var clean []string
	for _, a := range s.Args {
		if a == "--no-rtk" {
			disabled = true
		} else {
			clean = append(clean, a)
		}
	}
	s.Args = clean
	if cfg == nil || cfg.RTK == nil || !cfg.RTK.Enabled || cfg.EngineSuspended(cfg.Engine) || disabled || envValue(env, "RTK_DISABLED") == "1" {
		report(ctx, cfg, false, "disabled", "", nativeVersion)
		return s, nil
	}
	if hookConflict(cfg.Engine, home) {
		return s, errors.New("hook_conflict")
	}
	bin, err := Install(ctx, cfg)
	if err != nil {
		return s, err
	}
	r, err := root()
	if err != nil {
		return s, err
	}
	sessions := filepath.Join(r, "sessions")
	if err = os.MkdirAll(sessions, 0700); err != nil {
		return s, err
	}
	cleanupAbandoned(sessions)
	dir, err := os.MkdirTemp(sessions, "session-")
	if err != nil {
		return s, err
	}
	s.Dir = dir
	db, dbErr := sql.Open("sqlite", filepath.Join(dir, "recall.db"))
	if dbErr != nil {
		os.RemoveAll(dir)
		return s, errors.New("recall_failed")
	}
	_, dbErr = db.Exec("PRAGMA auto_vacuum=INCREMENTAL")
	db.Close()
	if dbErr != nil {
		os.RemoveAll(dir)
		return s, errors.New("recall_failed")
	}
	s.Binary = bin
	failed := true
	defer func() {
		if failed {
			s.Close()
			os.RemoveAll(s.Dir)
			s.Args = append([]string{}, args...)
			s.Env = append([]string{}, env...)
		}
	}()
	s.lease, err = os.OpenFile(filepath.Join(dir, ".lease"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return s, err
	}
	if err = syscall.Flock(int(s.lease.Fd()), syscall.LOCK_SH); err != nil {
		return s, err
	}
	common, err := os.Executable()
	if err != nil {
		return s, err
	}
	common, err = layout.CommonExecutable(common)
	if err != nil {
		return s, err
	}
	shim := filepath.Join(dir, "bin")
	if err = os.Mkdir(shim, 0700); err != nil {
		return s, err
	}
	if err = os.WriteFile(filepath.Join(shim, "rtk"), []byte("#!/bin/sh\nexec "+quote(common)+" rtk exec \"$@\"\n"), 0700); err != nil {
		return s, err
	}
	for k, v := range map[string]string{sessionEnv: dir, binaryEnv: bin, "RTK_RECALL_DB": filepath.Join(dir, "recall.db"), "RTK_TEE_DIR": filepath.Join(dir, "tee"), "RTK_DB_PATH": filepath.Join(dir, "tracking.db"), "RTK_TELEMETRY_DISABLED": "1", "RTK_SUPPRESS_HOOK_WARNING": "1", "PATH": shim + string(os.PathListSeparator) + envValue(env, "PATH")} {
		s.Env = setEnv(s.Env, k, v)
	}
	instruction := awareness + " Use " + quote(filepath.Join(shim, "rtk")) + " in place of rtk in this session."
	switch cfg.Engine {
	case "codex":
		s.Args, err = codexInstructions(home, s.Args, instruction)
		if err != nil {
			return s, err
		}
	case "claude":
		s.Args = appendInstructionFlag(s.Args, "--append-system-prompt", instruction)
	case "grok":
		s.Args = appendInstructionFlag(s.Args, "--rules", instruction)
	default:
		return s, errors.New("unsupported_native")
	}
	s.Mode = "instructions"
	report(ctx, cfg, true, "", s.Mode, nativeVersion)
	failed = false
	return s, nil
}

func (s *Session) Attach(cmd *exec.Cmd) {
	if s.lease != nil {
		cmd.ExtraFiles = append(cmd.ExtraFiles, s.lease)
	}
}
func (s *Session) Close() {
	if s == nil {
		return
	}
	if s.lease != nil {
		s.lease.Close()
		s.lease = nil
	}
	if s.Dir != "" {
		if f, e := os.OpenFile(filepath.Join(s.Dir, ".lease"), os.O_RDWR, 0600); e == nil {
			defer f.Close()
			if syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil {
				os.RemoveAll(s.Dir)
			}
		}
	}
}
func cleanupAbandoned(root string) {
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "session-") {
			continue
		}
		p := filepath.Join(root, e.Name())
		i, err := e.Info()
		if err != nil || time.Since(i.ModTime()) < 24*time.Hour {
			continue
		}
		f, err := os.OpenFile(filepath.Join(p, ".lease"), os.O_RDWR, 0600)
		if err != nil {
			continue
		}
		if syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil {
			os.RemoveAll(p)
		}
		f.Close()
	}
}
func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
func envValue(env []string, k string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if strings.HasPrefix(env[i], k+"=") {
			return strings.TrimPrefix(env[i], k+"=")
		}
	}
	return ""
}
func setEnv(env []string, k, v string) []string {
	out := make([]string, 0, len(env)+1)
	for _, e := range env {
		if !strings.HasPrefix(e, k+"=") {
			out = append(out, e)
		}
	}
	return append(out, k+"="+v)
}
func errorCode(err error) string {
	switch err.Error() {
	case "unsupported_platform":
		return "unsupported_platform"
	case "checksum_mismatch", "invalid_archive", "invalid_artifact":
		return "integrity_failed"
	case "unsupported_native", "hook_conflict", "recall_failed":
		return err.Error()
	case "unsupported_policy":
		return "unsupported_native"
	}
	if strings.HasPrefix(err.Error(), "download_failed") {
		return "download_failed"
	}
	return "install_failed"
}
func report(ctx context.Context, cfg *config.Config, ready bool, code, mode string, nativeVersion string) {
	if cfg == nil || cfg.RTK == nil {
		return
	}
	b, _ := json.Marshal(map[string]any{"engine": cfg.Engine, "wrapper_version": buildinfo.Version, "native_version": safeVersion(nativeVersion), "rtk_version": Version, "policy_revision": cfg.RTK.PolicyRevision, "ready": ready, "error_code": code, "adapter_mode": actualMode(cfg, mode)})
	var payload map[string]any
	_ = json.Unmarshal(b, &payload)
	if code == "" {
		delete(payload, "error_code")
	}
	b, _ = json.Marshal(payload)
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(cfg.Orchestrator.BaseURL, "/")+"/host/rtk/report", bytes.NewReader(b))
	if e != nil {
		return
	}
	req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
	communicator.SetAPIHeader(req.Header)
	req.Header.Set("Content-Type", "application/json")
	c, e := update.HTTPClient(cfg)
	if e != nil {
		return
	}
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	r, e := c.Do(req)
	if e == nil {
		r.Body.Close()
	}
}

// pruneRecall bounds RTK's pinned SQLite schema without touching user stores.
func pruneRecall(dir string) error {
	p := filepath.Join(dir, "recall.db")
	if _, e := os.Stat(p); e == nil {
		db, e := sql.Open("sqlite", p)
		if e != nil {
			return e
		}
		defer db.Close()
		db.Exec("PRAGMA busy_timeout=1000")
		var exists int
		if e = db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='recall'").Scan(&exists); e != nil {
			return e
		}
		if exists > 0 {
			if _, e = db.Exec("DELETE FROM recall WHERE byte_size > ? OR created_at < ? OR hash NOT IN (SELECT hash FROM recall ORDER BY created_at DESC LIMIT 10)", 10<<20, time.Now().Add(-24*time.Hour).Unix()); e != nil {
				return e
			}
			if _, e = db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); e != nil {
				return e
			}
			if _, e = db.Exec("PRAGMA incremental_vacuum"); e != nil {
				return e
			}
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	tee := filepath.Join(dir, "tee")
	entries, e := os.ReadDir(tee)
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	type file struct {
		path string
		at   time.Time
	}
	var files []file
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		i, e := entry.Info()
		if e != nil {
			return e
		}
		path := filepath.Join(tee, entry.Name())
		if i.Size() > 10<<20 || time.Since(i.ModTime()) > 24*time.Hour {
			if e = os.Remove(path); e != nil {
				return e
			}
		} else {
			files = append(files, file{path, i.ModTime()})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].at.After(files[j].at) })
	for i := 10; i < len(files); i++ {
		if e = os.Remove(files[i].path); e != nil {
			return e
		}
	}
	return nil
}

func validSession() (string, string, error) {
	dir := os.Getenv(sessionEnv)
	bin := os.Getenv(binaryEnv)
	r, e := root()
	if e != nil {
		return "", "", e
	}
	rel, e := filepath.Rel(filepath.Join(r, "sessions"), dir)
	if e != nil || strings.HasPrefix(rel, "..") || rel == "." || !strings.HasPrefix(filepath.Base(dir), "session-") {
		return "", "", errors.New("RTK session unavailable")
	}
	expected, e := binaryPath()
	if e != nil || bin != expected {
		return "", "", errors.New("RTK binary unavailable")
	}
	return dir, bin, nil
}

// Exec is the session's rtk shim, retaining native exit status and live streams.
func Exec(ctx context.Context, args []string, in io.Reader, out, stderr io.Writer) int {
	dir, bin, e := validSession()
	if e != nil {
		fmt.Fprintln(stderr, e)
		return 1
	}
	defer func() {
		if err := pruneRecall(dir); err != nil {
			os.WriteFile(filepath.Join(dir, ".recall-disabled"), []byte("retention unavailable"), 0600)
			fmt.Fprintln(stderr, "cxx: RTK recall retention unavailable; further recall is disabled for this session")
		}
	}()
	cmd := exec.CommandContext(ctx, bin, args...)
	if _, err := os.Stat(filepath.Join(dir, ".recall-disabled")); err == nil {
		cmd.Env = setEnv(os.Environ(), "RTK_RECALL", "0")
		cmd.Env = setEnv(cmd.Env, "RTK_TEE", "0")
	}
	cmd.Stdin = in
	cmd.Stdout = out
	cmd.Stderr = stderr
	err := cmd.Run()
	if err == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	return 1
}

// AttachChild lets Grok's launch supervisor carry the same recall lease.
func (s *Session) AttachChild(cmd *exec.Cmd) (func(), error) { s.Attach(cmd); return func() {}, nil }

var versionPattern = regexp.MustCompile(`[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?`)

func safeVersion(s string) string {
	v := versionPattern.FindString(s)
	if len(v) > 80 {
		return ""
	}
	return v
}
func hookConflict(engine, home string) bool {
	h, _ := os.UserHomeDir()
	var paths []string
	switch engine {
	case "codex":
		paths = []string{filepath.Join(home, "hooks.json"), filepath.Join(home, "config.toml")}
	case "claude":
		paths = []string{filepath.Join(h, ".claude", "settings.json"), filepath.Join(h, ".claude", "settings.local.json")}
	case "grok":
		paths = []string{filepath.Join(home, "config.toml"), filepath.Join(home, "managed_config.toml"), filepath.Join(h, ".claude", "settings.json")}
	}
	dirs := []string{filepath.Join(home, "hooks")}
	if cwd, e := os.Getwd(); e == nil {
		paths = append(paths, filepath.Join(cwd, "."+engine, "hooks.json"), filepath.Join(cwd, ".claude", "settings.json"), filepath.Join(cwd, ".claude", "settings.local.json"))
		dirs = append(dirs, filepath.Join(cwd, ".grok", "hooks"))
	}
	for _, dir := range dirs {
		entries, _ := os.ReadDir(dir)
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
				paths = append(paths, filepath.Join(dir, entry.Name()))
			}
		}
	}
	for _, p := range paths {
		b, e := os.ReadFile(p)
		if e == nil && (bytes.Contains(b, []byte("rtk hook")) || bytes.Contains(b, []byte("rtk-rewrite"))) {
			return true
		}
	}
	return false
}

func actualMode(cfg *config.Config, mode string) string { return "instructions" }

// appendInstructionFlag preserves an operator's existing additive prompt flag.
func appendInstructionFlag(args []string, flag, instruction string) []string {
	out := append([]string{}, args...)
	for i, a := range out {
		if a == "--" {
			break
		}
		if a == flag && i+1 < len(out) {
			out[i+1] += "\n\n" + instruction
			return out
		}
		if strings.HasPrefix(a, flag+"=") {
			out[i] += "\n\n" + instruction
			return out
		}
	}
	return append([]string{flag, instruction}, out...)
}
func codexInstructions(home string, args []string, instruction string) ([]string, error) {
	prior := ""
	if raw, e := os.ReadFile(filepath.Join(home, "config.toml")); e == nil {
		t, e := toml.LoadBytes(raw)
		if e != nil {
			return nil, errors.New("unsupported_native")
		}
		prior, _ = t.Get("developer_instructions").(string)
	} else if !os.IsNotExist(e) {
		return nil, errors.New("unsupported_native")
	}
	var out []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			out = append(out, args[i:]...)
			break
		}
		if (a == "-c" || a == "--config") && i+1 < len(args) {
			kv := args[i+1]
			if strings.TrimSpace(strings.SplitN(kv, "=", 2)[0]) == "developer_instructions" {
				t, e := toml.Load(kv)
				if e != nil {
					return nil, errors.New("unsupported_native")
				}
				prior, _ = t.Get("developer_instructions").(string)
				i++
				continue
			}
		}
		if strings.HasPrefix(a, "--config=developer_instructions=") {
			t, e := toml.Load(strings.TrimPrefix(a, "--config="))
			if e != nil {
				return nil, errors.New("unsupported_native")
			}
			prior, _ = t.Get("developer_instructions").(string)
			continue
		}
		out = append(out, a)
	}
	return append([]string{"-c", "developer_instructions=" + strconv.Quote(prior+"\n\n"+instruction)}, out...), nil
}

type sessionContextKey struct{}

func WithSession(ctx context.Context, s *Session) context.Context {
	return context.WithValue(ctx, sessionContextKey{}, s)
}
func AttachContext(ctx context.Context, cmd *exec.Cmd) {
	if s, ok := ctx.Value(sessionContextKey{}).(*Session); ok {
		s.Attach(cmd)
	}
}
