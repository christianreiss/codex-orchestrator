// Package enginedestroy removes one engine completely from this host.
//
// It backs the fleet-wide "destroy engine" request: the signed config carries
// host.destroy_engines, and the cron coordinator calls Run for every engine
// named there that has not been completed for that request id yet. Unlike
// suspension (nothing is deleted) and host-level removal (config and alias
// only), Run removes the engine's signed config, alias, native shim, pinned
// binary store, npm-global install, home directories (including credentials
// and history) and shell alias lines.
//
// Run is idempotent and never returns early on a single failure: whatever it
// could not remove comes back in Result.Residue so the server can show it.
package enginedestroy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// Options injects everything that touches the outside world, so tests run
// against a temporary HOME and cron can reuse its own alias/config helpers.
type Options struct {
	// Home is the user's home directory. Required and absolute.
	Home string
	// Getenv defaults to os.Getenv ($CODEX_HOME, $GROK_HOME, $TMPDIR).
	Getenv func(string) string
	// ConfigPath resolves an engine's signed config path.
	ConfigPath func(engine string) (string, error)
	// RemoveAlias removes the cdx/clx/cgx alias. May be nil.
	RemoveAlias func(ctx context.Context, engine string) error
	// RemoveShim removes the native PATH shim for the engine. May be nil.
	RemoveShim func(engine string) error
	// NPMUninstall removes an npm-global package; it must treat "not
	// installed" as success. Nil uses the real npm when it is on PATH.
	NPMUninstall func(ctx context.Context, pkg string) error
}

// Result lists what was removed and what could not be.
type Result struct {
	Engine  string   `json:"engine"`
	Removed []string `json:"removed"`
	Residue []string `json:"residue"`
}

// Complete reports whether nothing was left behind.
func (r Result) Complete() bool { return len(r.Residue) == 0 }

type run struct {
	opt Options
	res Result
}

// Run destroys engine on this host.
func Run(ctx context.Context, engine string, opt Options) (Result, error) {
	res := Result{Engine: engine, Removed: []string{}, Residue: []string{}}
	switch engine {
	case config.EngineCodex, config.EngineClaude, config.EngineGrok:
	default:
		return res, fmt.Errorf("unsupported engine %q", engine)
	}
	if !filepath.IsAbs(opt.Home) || filepath.Clean(opt.Home) == string(filepath.Separator) {
		return res, errors.New("enginedestroy requires an absolute, non-root home directory")
	}
	if opt.Getenv == nil {
		opt.Getenv = os.Getenv
	}
	if opt.ConfigPath == nil {
		opt.ConfigPath = config.DefaultPathForEngine
	}
	r := &run{opt: opt, res: res}
	r.destroy(ctx, engine)
	return r.res, nil
}

func (r *run) residue(what string, err error) {
	r.res.Residue = append(r.res.Residue, fmt.Sprintf("%s: %v", what, err))
}

// tree removes a file or directory tree. Anything outside Home, Home itself
// and the filesystem root are refused so a bad env override cannot widen it.
func (r *run) tree(path string) {
	path = filepath.Clean(path)
	if path == "" || !filepath.IsAbs(path) || path == string(filepath.Separator) || path == filepath.Clean(r.opt.Home) {
		r.residue(path, errors.New("refused: unsafe path"))
		return
	}
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return
	}
	if err := os.RemoveAll(path); err != nil {
		r.residue(path, err)
		return
	}
	r.res.Removed = append(r.res.Removed, path)
}

func (r *run) glob(pattern string) {
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return
	}
	for _, m := range matches {
		r.tree(m)
	}
}

func (r *run) destroy(ctx context.Context, engine string) {
	home := r.opt.Home
	if r.opt.RemoveShim != nil {
		if err := r.opt.RemoveShim(engine); err != nil {
			r.residue("native shim", err)
		}
	}
	if r.opt.RemoveAlias != nil {
		if err := r.opt.RemoveAlias(ctx, engine); err != nil {
			r.residue("alias", err)
		}
	}
	if path, err := r.opt.ConfigPath(engine); err != nil {
		r.residue("signed config path", err)
	} else {
		r.tree(path)
		r.tree(path + ".sig")
	}
	r.tree(filepath.Join(home, ".cxx", "engines", engine))
	cfgDir := filepath.Join(home, ".config", "codex-orchestrator")
	tmp := r.opt.Getenv("TMPDIR")
	if tmp == "" {
		tmp = os.TempDir()
	}
	switch engine {
	case config.EngineGrok:
		grokHome := r.opt.Getenv("GROK_HOME")
		if grokHome == "" {
			grokHome = filepath.Join(home, ".grok")
		}
		r.tree(grokHome)
		r.tree(filepath.Join(home, ".cgx"))
		r.glob(filepath.Join(tmp, "cgx-runtime-*"))
		r.glob(filepath.Join(tmp, "cgx-login-*"))
		for _, rc := range []string{".bashrc", ".zshrc"} {
			r.stripAlias(filepath.Join(home, rc))
		}
	case config.EngineClaude:
		r.stripManagedMCP(filepath.Join(home, ".claude.json"), filepath.Join(home, ".clx", "state", "managed-mcp.json"))
		r.tree(filepath.Join(home, ".claude"))
		r.tree(filepath.Join(home, ".clx"))
		r.npm(ctx, "@anthropic-ai/claude-code")
	case config.EngineCodex:
		codexHome := r.opt.Getenv("CODEX_HOME")
		if codexHome == "" {
			codexHome = filepath.Join(home, ".codex")
		}
		r.tree(codexHome)
		r.tree(filepath.Join(cfgDir, "cdx-codex-bin"))
		r.tree(filepath.Join(cfgDir, "cdx-code-mode-host-state"))
		r.npm(ctx, "@openai/codex")
		r.npm(ctx, "codex-cli")
	}
}

func (r *run) npm(ctx context.Context, pkg string) {
	fn := r.opt.NPMUninstall
	if fn == nil {
		fn = defaultNPMUninstall
	}
	if err := fn(ctx, pkg); err != nil {
		r.residue("npm uninstall "+pkg, err)
		return
	}
}

func defaultNPMUninstall(ctx context.Context, pkg string) error {
	if _, err := exec.LookPath("npm"); err != nil {
		return nil
	}
	if exec.CommandContext(ctx, "npm", "ls", "-g", "--depth=0", pkg).Run() != nil {
		return nil // not installed
	}
	if out, err := exec.CommandContext(ctx, "npm", "uninstall", "-g", pkg).CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// stripAlias removes the `alias grok='cgx'` line and its "# Added by cgx"
// comment from a shell rc file, leaving everything else byte-for-byte.
func (r *run) stripAlias(path string) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		r.residue(path, err)
		return
	}
	lines := strings.Split(string(b), "\n")
	out := make([]string, 0, len(lines))
	changed := false
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if t == "alias grok='cgx'" || t == "# Added by cgx" {
			changed = true
			continue
		}
		out = append(out, line)
	}
	if !changed {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		r.residue(path, err)
		return
	}
	if err := os.WriteFile(path, []byte(strings.Join(out, "\n")), info.Mode().Perm()); err != nil {
		r.residue(path, err)
		return
	}
	r.res.Removed = append(r.res.Removed, path+" (grok alias lines)")
}

// stripManagedMCP drops the fleet-managed mcpServers recorded in the sidecar
// from ~/.claude.json, keeping every user-authored server. It runs before the
// sidecar's directory is deleted.
func (r *run) stripManagedMCP(claudeJSON, sidecar string) {
	sb, err := os.ReadFile(sidecar)
	if err != nil {
		return
	}
	var state struct {
		Names []string `json:"names"`
	}
	if json.Unmarshal(sb, &state) != nil || len(state.Names) == 0 {
		return
	}
	cb, err := os.ReadFile(claudeJSON)
	if err != nil {
		return
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(cb, &doc) != nil {
		r.residue(claudeJSON, errors.New("not valid JSON; managed mcpServers left in place"))
		return
	}
	var servers map[string]json.RawMessage
	if json.Unmarshal(doc["mcpServers"], &servers) != nil {
		return
	}
	for _, name := range state.Names {
		delete(servers, name)
	}
	enc, err := json.Marshal(servers)
	if err != nil {
		r.residue(claudeJSON, err)
		return
	}
	doc["mcpServers"] = enc
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		r.residue(claudeJSON, err)
		return
	}
	info, err := os.Stat(claudeJSON)
	if err != nil {
		r.residue(claudeJSON, err)
		return
	}
	if err := os.WriteFile(claudeJSON, append(out, '\n'), info.Mode().Perm()); err != nil {
		r.residue(claudeJSON, err)
		return
	}
	r.res.Removed = append(r.res.Removed, claudeJSON+" (managed mcpServers)")
}

// --- completion marker -------------------------------------------------

func markerPath(home, engine string) string {
	return filepath.Join(home, ".cxx", "state", "engine-destroy-"+engine+".json")
}

// Done reports whether this host already completed request requestID.
func Done(home, engine, requestID string) bool {
	b, err := os.ReadFile(markerPath(home, engine))
	if err != nil {
		return false
	}
	var m struct {
		RequestID string `json:"request_id"`
	}
	return json.Unmarshal(b, &m) == nil && m.RequestID == requestID && requestID != ""
}

// MarkDone records a fully completed request.
func MarkDone(home, engine, requestID string) error {
	p := markerPath(home, engine)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(map[string]string{"request_id": requestID})
	return os.WriteFile(p, b, 0o600)
}
