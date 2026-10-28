// Package emergency implements `cxx emergency <engine> [--] [args…]`: a launch
// path that bypasses the Orchestrator entirely and replaces the process with
// the plain native engine CLI.
//
// It exists for the case where the fleet machinery itself is what is broken
// (API unreachable, config sync wedged, a stuck lease or journal). To stay
// useful in that case it deliberately imports none of the persona or app
// packages and touches no state: no network, no sync, no auth sessions,
// leases, communicator, quota, argv/env rewriting or cache writes.
//
// The only gate is the signed per-host config. Emergency mode runs when, and
// only when, the Ed25519-verified config says host.secure=true: an insecure
// host purges its credentials after every run, so the native CLI could not
// authenticate there anyway, and an unverifiable config proves nothing.
package emergency

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeentry"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

// Options injects the process-level seams; the zero value is production.
type Options struct {
	// PublicKey returns the key the signed config must verify against.
	PublicKey func() (ed25519.PublicKey, error)
	// Exec replaces (or, on platforms without exec(2), runs) the native CLI.
	// On success a replacing implementation never returns.
	Exec func(path string, argv, env []string) (int, error)
	// Executable is this binary's path, used to keep the wrapper and its shims
	// from being mistaken for the native CLI.
	Executable string
}

type engineSpec struct {
	name     string // vendor executable name
	binEnv   string // operator override for the native CLI path
	cacheRel []string
}

var specs = map[string]engineSpec{
	config.EngineCodex:  {name: "codex", binEnv: "CDX_CODEX_BIN", cacheRel: []string{".config", "codex-orchestrator", "cdx-codex-bin"}},
	config.EngineClaude: {name: "claude", binEnv: "CLX_CLAUDE_BIN", cacheRel: []string{".clx", "state", "claude-bin"}},
	config.EngineGrok:   {name: "grok", binEnv: "CGX_GROK_BIN", cacheRel: []string{".cgx", "state", "grok-bin"}},
}

// wrapperEnvPrefixes mark variables owned by the cxx wrappers. They steer
// wrapper behaviour only and mean nothing to a native CLI.
var wrapperEnvPrefixes = []string{"CDX_", "CLX_", "CGX_", "CXX_"}

const usage = `Usage: cxx emergency codex|claude|grok [--] [native arguments]

Runs the plain native engine CLI without the Orchestrator: no config or auth
sync, quota checks, skills, MCP injection, leases or communicator. Only
available on hosts whose signed config says host.secure=true.`

// Run executes emergency mode. args are everything after "emergency".
func Run(args []string, stdout, stderr io.Writer) int {
	return RunWith(args, stdout, stderr, Options{})
}

// RunWith is Run with injectable seams for tests.
func RunWith(args []string, stdout, stderr io.Writer, opts Options) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	switch args[0] {
	case "-h", "--help", "help":
		fmt.Fprintln(stdout, usage)
		return 0
	}
	engine := args[0]
	spec, ok := specs[engine]
	if !ok {
		fmt.Fprintf(stderr, "cxx emergency: unknown engine %q (want codex, claude or grok)\n", engine)
		return 2
	}
	native := args[1:]
	if len(native) > 0 && native[0] == "--" {
		native = native[1:]
	}
	if opts.PublicKey == nil {
		opts.PublicKey = signing.PublicKey
	}
	if opts.Exec == nil {
		opts.Exec = execNative
	}
	if opts.Executable == "" {
		opts.Executable, _ = os.Executable()
	}

	cfg, err := requireSecure(engine, opts)
	if err != nil {
		fmt.Fprintf(stderr, "cxx emergency: refusing to run %s: %v\n", engine, err)
		return 1
	}
	env := os.Environ()
	path, err := resolveBinary(spec, env, opts.Executable)
	if err != nil {
		fmt.Fprintf(stderr, "cxx emergency: %v\n", err)
		return 1
	}
	if engine == config.EngineGrok {
		if err := requireGrokLogin(env); err != nil {
			fmt.Fprintf(stderr, "cxx emergency: %v\n", err)
			return 1
		}
	}
	fmt.Fprintf(stderr, "cxx emergency: Orchestrator bypassed; running native %s (%s). No sync, quota, MCP, skills or auth refresh. Previously synced engine config stays on disk untouched.\n", spec.name, path)
	code, err := opts.Exec(path, append([]string{path}, native...), scrubEnv(env, cfg))
	if err != nil {
		fmt.Fprintf(stderr, "cxx emergency: cannot start %s: %v\n", path, err)
		if code == 0 {
			code = 1
		}
	}
	return code
}

// requireSecure proves host.secure=true from the verified signed config. An
// expired config still counts when its signature verified: the flag was signed
// by the fleet and expiry only bounds how long sync may rely on it.
func requireSecure(engine string, opts Options) (*config.Config, error) {
	pub, err := opts.PublicKey()
	if err != nil {
		return nil, fmt.Errorf("cannot verify the signed host config: %w", err)
	}
	path, err := config.DefaultPathForEngine(engine)
	if err != nil {
		return nil, err
	}
	cfg, err := config.LoadForEngine(path, pub, false, engine)
	var expired *config.ExpiredError
	if errors.As(err, &expired) && expired.Config != nil {
		cfg, err = expired.Config, nil
	}
	if err != nil {
		return nil, fmt.Errorf("signed host config unusable, so host.secure cannot be proven: %w", err)
	}
	if !cfg.Host.Secure {
		return nil, errors.New("host is not marked secure; insecure hosts purge their credentials, so emergency mode is not offered")
	}
	return cfg, nil
}

// resolveBinary finds the native CLI without writing anything (unlike the
// persona FindCLI helpers, which refresh a path cache). The operator override
// is authoritative: a bad override is an error, never a silent fallthrough.
func resolveBinary(spec engineSpec, env []string, self string) (string, error) {
	if v := strings.TrimSpace(getenv(env, spec.binEnv)); v != "" {
		if !usable(v, self) {
			return "", fmt.Errorf("%s=%q is not an executable native CLI", spec.binEnv, v)
		}
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine home directory: %w", err)
	}
	var candidates []string
	if raw, err := os.ReadFile(filepath.Join(append([]string{home}, spec.cacheRel...)...)); err == nil {
		candidates = append(candidates, strings.TrimSpace(string(raw)))
	}
	if spec.name == "grok" {
		candidates = append(candidates, filepath.Join(grokHome(env, home), "bin", "grok"))
	}
	for _, c := range candidates {
		if c != "" && usable(c, self) {
			return c, nil
		}
	}
	if p, err := nativeentry.ResolveVendor(spec.name, self); err == nil {
		return p, nil
	}
	if spec.name == "claude" {
		if p, err := nativeentry.ResolveVendor("claude-code", self); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("native %s CLI not found (install it, or set %s)", spec.name, spec.binEnv)
}

func usable(path, self string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 && !nativeentry.IsWrapperOrShim(path, self)
}

func grokHome(env []string, home string) string {
	if v := strings.TrimSpace(getenv(env, "GROK_HOME")); v != "" {
		return v
	}
	return filepath.Join(home, ".grok")
}

// requireGrokLogin: Grok credentials are server-owned, so there is no cached
// fleet copy to fall back on. A native login in the Grok home is the only way
// the plain CLI can authenticate.
func requireGrokLogin(env []string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("cannot determine home directory: %w", err)
	}
	auth := filepath.Join(grokHome(env, home), "auth.json")
	if info, err := os.Stat(auth); err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("no native Grok login at %s; Grok credentials are fleet-managed, so emergency mode cannot authenticate (run `grok login` once the fleet is reachable, or log in natively)", auth)
	}
	return nil
}

// scrubEnv removes wrapper-owned variables and any orchestrator routing that a
// parent managed session injected, so the native CLI talks to its own provider.
// A user's own provider keys and base URLs are left alone.
func scrubEnv(env []string, cfg *config.Config) []string {
	base := strings.TrimRight(strings.TrimSpace(cfg.Orchestrator.BaseURL), "/")
	drop := map[string]bool{}
	for _, pair := range []struct{ url, key, token string }{
		{"OPENAI_BASE_URL", "OPENAI_API_KEY", ""},
		{"ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"},
	} {
		routed := base != "" && strings.HasPrefix(getenv(env, pair.url), base)
		if routed {
			drop[pair.url] = true
		}
		for _, k := range []string{pair.key, pair.token} {
			if k == "" {
				continue
			}
			if v := getenv(env, k); routed || (v != "" && v == cfg.Orchestrator.APIKey) {
				drop[k] = true
			}
		}
	}
	out := make([]string, 0, len(env))
	for _, item := range env {
		key, _, _ := strings.Cut(item, "=")
		if drop[key] || hasAnyPrefix(key, wrapperEnvPrefixes) {
			continue
		}
		out = append(out, item)
	}
	return out
}

func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

func getenv(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if k, v, ok := strings.Cut(env[i], "="); ok && k == key {
			return v
		}
	}
	return ""
}
