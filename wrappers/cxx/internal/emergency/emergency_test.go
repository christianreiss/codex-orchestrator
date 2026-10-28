package emergency

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

const orchURL = "https://orch.example.com"

type launch struct {
	path string
	argv []string
	env  []string
}

type harness struct {
	t    *testing.T
	home string
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
	got  *launch
	opts Options
}

// newHarness isolates HOME/PATH, clears every variable emergency mode reads,
// and installs a recording Exec so no test ever replaces the test process.
func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{t: t, home: t.TempDir()}
	var err error
	h.pub, h.priv, err = ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", h.home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("PATH", filepath.Join(h.home, "emptybin"))
	for _, k := range []string{"CDX_CONFIG_PATH", "CLX_CONFIG_PATH", "CGX_CONFIG_PATH", "CDX_CODEX_BIN", "CLX_CLAUDE_BIN", "CGX_GROK_BIN", "GROK_HOME",
		"OPENAI_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	h.opts = Options{
		PublicKey:  func() (ed25519.PublicKey, error) { return h.pub, nil },
		Executable: filepath.Join(h.home, "cxx"),
		Exec: func(path string, argv, env []string) (int, error) {
			h.got = &launch{path, argv, env}
			return 0, nil
		},
	}
	return h
}

func (h *harness) writeConfig(engine string, secure bool, expiresAt string) {
	h.t.Helper()
	cfg := &config.Config{
		SchemaVersion: 1,
		Engine:        engine,
		IssuedAt:      "2026-05-16T10:00:00Z",
		Orchestrator:  config.Orchestrator{BaseURL: orchURL, APIKey: "sk-orch-key", InstallationID: "install-1"},
		Host:          config.Host{ID: 42, FQDN: "host01.example.com", Secure: secure},
		Wrapper: config.Wrapper{
			Version: "0.6.0", Track: "stable", AutoUpdate: true,
			BinaryURL:    orchURL + "/wrapper/v2/bin/x/linux-amd64/v0.6.0/x",
			BinarySHA256: strings.Repeat("0", 64),
		},
	}
	if expiresAt != "" {
		cfg.ExpiresAt = &expiresAt
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		h.t.Fatal(err)
	}
	path, err := config.DefaultPathForEngine(engine)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		h.t.Fatal(err)
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(h.priv, raw))
	if err := os.WriteFile(path+".sig", []byte(sig), 0o600); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) stubCLI(name string) string {
	h.t.Helper()
	path := filepath.Join(h.home, "vendor", name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		h.t.Fatal(err)
	}
	return path
}

func (h *harness) run(args ...string) (int, string) {
	var out, errb bytes.Buffer
	code := RunWith(args, &out, &errb, h.opts)
	return code, errb.String()
}

func (h *harness) snapshot() []string {
	var files []string
	_ = filepath.Walk(h.home, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			files = append(files, p)
		}
		return nil
	})
	return files
}

func envMap(env []string) map[string]string {
	m := map[string]string{}
	for _, e := range env {
		k, v, _ := strings.Cut(e, "=")
		m[k] = v
	}
	return m
}

func TestSecureHostLaunchesNativeCLIVerbatim(t *testing.T) {
	cases := []struct{ engine, bin, binEnv string }{
		{config.EngineCodex, "codex", "CDX_CODEX_BIN"},
		{config.EngineClaude, "claude", "CLX_CLAUDE_BIN"},
	}
	for _, tc := range cases {
		t.Run(tc.engine, func(t *testing.T) {
			h := newHarness(t)
			h.writeConfig(tc.engine, true, "")
			cli := h.stubCLI(tc.bin)
			t.Setenv(tc.binEnv, cli)
			before := h.snapshot()
			code, stderr := h.run(tc.engine, "--", "--version", "-p", "hi there")
			if code != 0 || h.got == nil {
				t.Fatalf("code=%d got=%v stderr=%s", code, h.got, stderr)
			}
			if h.got.path != cli {
				t.Fatalf("exec path = %q, want %q", h.got.path, cli)
			}
			want := []string{cli, "--version", "-p", "hi there"}
			if strings.Join(h.got.argv, "\x00") != strings.Join(want, "\x00") {
				t.Fatalf("argv = %q, want %q", h.got.argv, want)
			}
			if !strings.Contains(stderr, "Orchestrator bypassed") {
				t.Fatalf("missing bypass banner: %s", stderr)
			}
			if after := h.snapshot(); len(after) != len(before) {
				t.Fatalf("emergency mode wrote files: before=%v after=%v", before, after)
			}
		})
	}
}

func TestExpiredButVerifiedSecureConfigStillLaunches(t *testing.T) {
	h := newHarness(t)
	h.writeConfig(config.EngineCodex, true, "2026-06-01T00:00:00Z")
	t.Setenv("CDX_CODEX_BIN", h.stubCLI("codex"))
	if code, stderr := h.run("codex"); code != 0 || h.got == nil {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
}

func TestRefusesWhenSecureCannotBeProven(t *testing.T) {
	cases := map[string]func(h *harness){
		"insecure host": func(h *harness) { h.writeConfig(config.EngineCodex, false, "") },
		"missing config": func(h *harness) {
			// no config written
		},
		"missing signature": func(h *harness) {
			h.writeConfig(config.EngineCodex, true, "")
			path, _ := config.DefaultPathForEngine(config.EngineCodex)
			os.Remove(path + ".sig")
		},
		"signature by another key": func(h *harness) {
			h.writeConfig(config.EngineCodex, true, "")
			_, other, _ := ed25519.GenerateKey(rand.Reader)
			path, _ := config.DefaultPathForEngine(config.EngineCodex)
			raw, _ := os.ReadFile(path)
			os.WriteFile(path+".sig", []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(other, raw))), 0o600)
		},
		"engine mismatch": func(h *harness) {
			// A claude-signed config served at the codex path must not unlock codex.
			h.writeConfig(config.EngineClaude, true, "")
			claudePath, _ := config.DefaultPathForEngine(config.EngineClaude)
			codexPath, _ := config.DefaultPathForEngine(config.EngineCodex)
			raw, _ := os.ReadFile(claudePath)
			sig, _ := os.ReadFile(claudePath + ".sig")
			os.WriteFile(codexPath, raw, 0o600)
			os.WriteFile(codexPath+".sig", sig, 0o600)
		},
		"no public key": func(h *harness) {
			h.writeConfig(config.EngineCodex, true, "")
			h.opts.PublicKey = func() (ed25519.PublicKey, error) { return nil, errors.New("no key") }
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			t.Setenv("CDX_CODEX_BIN", h.stubCLI("codex"))
			setup(h)
			code, stderr := h.run("codex")
			if code != 1 || h.got != nil {
				t.Fatalf("code=%d launched=%v stderr=%s", code, h.got != nil, stderr)
			}
			if !strings.Contains(stderr, "refusing to run codex") {
				t.Fatalf("stderr = %s", stderr)
			}
		})
	}
}

func TestBadBinaryOverrideIsAnErrorNotAFallthrough(t *testing.T) {
	h := newHarness(t)
	h.writeConfig(config.EngineCodex, true, "")
	// A real codex on PATH must not rescue a broken operator override.
	pathBin := filepath.Join(h.home, "emptybin")
	os.MkdirAll(pathBin, 0o755)
	os.WriteFile(filepath.Join(pathBin, "codex"), []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("CDX_CODEX_BIN", filepath.Join(h.home, "nope"))
	if code, _ := h.run("codex"); code != 1 || h.got != nil {
		t.Fatalf("code=%d launched=%v", code, h.got != nil)
	}
}

func TestResolvesFromReadOnlyCacheThenPath(t *testing.T) {
	h := newHarness(t)
	h.writeConfig(config.EngineClaude, true, "")
	cli := h.stubCLI("claude")
	cache := filepath.Join(h.home, ".clx", "state", "claude-bin")
	os.MkdirAll(filepath.Dir(cache), 0o755)
	os.WriteFile(cache, []byte(cli+"\n"), 0o600)
	if code, stderr := h.run("claude"); code != 0 || h.got == nil || h.got.path != cli {
		t.Fatalf("cache: code=%d got=%v stderr=%s", code, h.got, stderr)
	}

	h = newHarness(t)
	h.writeConfig(config.EngineClaude, true, "")
	pathBin := filepath.Join(h.home, "emptybin")
	os.MkdirAll(pathBin, 0o755)
	os.WriteFile(filepath.Join(pathBin, "claude"), []byte("#!/bin/sh\n"), 0o755)
	if code, stderr := h.run("claude"); code != 0 || h.got == nil || h.got.path != filepath.Join(pathBin, "claude") {
		t.Fatalf("PATH: code=%d got=%v stderr=%s", code, h.got, stderr)
	}
	// Resolution through PATH must not create the persona cache.
	if _, err := os.Stat(filepath.Join(h.home, ".clx")); err == nil {
		t.Fatal("PATH resolution wrote a cache")
	}
}

func TestBinaryNotFound(t *testing.T) {
	h := newHarness(t)
	h.writeConfig(config.EngineCodex, true, "")
	code, stderr := h.run("codex")
	if code != 1 || !strings.Contains(stderr, "CDX_CODEX_BIN") {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
}

func TestGrokNeedsNativeLogin(t *testing.T) {
	h := newHarness(t)
	h.writeConfig(config.EngineGrok, true, "")
	t.Setenv("CGX_GROK_BIN", h.stubCLI("grok"))
	code, stderr := h.run("grok")
	if code != 1 || h.got != nil || !strings.Contains(stderr, "no native Grok login") {
		t.Fatalf("code=%d launched=%v stderr=%s", code, h.got != nil, stderr)
	}

	grokHome := filepath.Join(h.home, "custom-grok")
	os.MkdirAll(grokHome, 0o755)
	os.WriteFile(filepath.Join(grokHome, "auth.json"), []byte("{}"), 0o600)
	t.Setenv("GROK_HOME", grokHome)
	if code, stderr := h.run("grok", "--", "chat"); code != 0 || h.got == nil {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
}

func TestEnvironmentIsScrubbedOfWrapperAndOrchestratorRouting(t *testing.T) {
	h := newHarness(t)
	h.writeConfig(config.EngineCodex, true, "")
	t.Setenv("CDX_CODEX_BIN", h.stubCLI("codex"))
	t.Setenv("CDX_HOST_ID", "42")
	t.Setenv("CXX_COMMUNICATOR_SYNC", "1")
	t.Setenv("OPENAI_BASE_URL", orchURL+"/v1")
	t.Setenv("OPENAI_API_KEY", "sk-orch-key")
	t.Setenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-mine")
	t.Setenv("KEEP_ME", "yes")
	if code, stderr := h.run("codex"); code != 0 || h.got == nil {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
	env := envMap(h.got.env)
	for _, k := range []string{"CDX_HOST_ID", "CDX_CODEX_BIN", "CXX_COMMUNICATOR_SYNC", "OPENAI_BASE_URL", "OPENAI_API_KEY"} {
		if _, ok := env[k]; ok {
			t.Errorf("%s leaked into the native environment", k)
		}
	}
	if env["ANTHROPIC_API_KEY"] != "sk-ant-mine" || env["ANTHROPIC_BASE_URL"] != "https://api.anthropic.com" || env["KEEP_ME"] != "yes" {
		t.Errorf("user-owned variables were not preserved: %v", env)
	}
}

func TestUsageErrors(t *testing.T) {
	h := newHarness(t)
	if code, _ := h.run(); code != 2 {
		t.Errorf("no engine: code=%d", code)
	}
	if code, stderr := h.run("gemini"); code != 2 || !strings.Contains(stderr, "unknown engine") {
		t.Errorf("unknown engine: code=%d stderr=%s", code, stderr)
	}
	var out, errb bytes.Buffer
	if code := RunWith([]string{"--help"}, &out, &errb, h.opts); code != 0 || !strings.Contains(out.String(), "Usage:") {
		t.Errorf("help: code=%d out=%s", code, out.String())
	}
}

func TestExecFailureIsReported(t *testing.T) {
	h := newHarness(t)
	h.writeConfig(config.EngineCodex, true, "")
	t.Setenv("CDX_CODEX_BIN", h.stubCLI("codex"))
	h.opts.Exec = func(string, []string, []string) (int, error) { return 0, errors.New("boom") }
	code, stderr := h.run("codex")
	if code != 1 || !strings.Contains(stderr, "boom") {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
}
