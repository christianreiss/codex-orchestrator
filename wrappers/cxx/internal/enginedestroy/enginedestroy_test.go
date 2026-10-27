package enginedestroy

import (
	"context"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func exists(path string) bool { _, err := os.Lstat(path); return err == nil }

func testOpts(home string, calls *[]string) Options {
	return Options{
		Home:   home,
		Getenv: func(k string) string { return map[string]string{"TMPDIR": filepath.Join(home, "tmp")}[k] },
		ConfigPath: func(e string) (string, error) {
			return filepath.Join(home, ".config", "codex-orchestrator", map[string]string{"grok": "cgx.json", "claude": "clx.json", "codex": "cdx.json"}[e]), nil
		},
		RemoveAlias:  func(_ context.Context, e string) error { *calls = append(*calls, "alias:"+e); return nil },
		RemoveShim:   func(e string) error { *calls = append(*calls, "shim:"+e); return nil },
		NPMUninstall: func(_ context.Context, p string) error { *calls = append(*calls, "npm:"+p); return nil },
	}
}

func TestDestroyGrokRemovesEverythingAndNothingElse(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, ".config", "codex-orchestrator")
	write(t, filepath.Join(cfg, "cgx.json"), "{}")
	write(t, filepath.Join(cfg, "cgx.json.sig"), "sig")
	write(t, filepath.Join(cfg, "clx.json"), "{}")
	write(t, filepath.Join(home, ".grok", "auth.json"), "secret")
	write(t, filepath.Join(home, ".cgx", "state", "grok-bin"), "x")
	write(t, filepath.Join(home, ".cxx", "engines", "grok", "1.0", "grok"), "bin")
	write(t, filepath.Join(home, ".cxx", "engines", "claude", "keep"), "bin")
	write(t, filepath.Join(home, "tmp", "cgx-runtime-abc", "f"), "x")
	if err := os.Chmod(filepath.Join(home, "tmp", "cgx-runtime-abc"), 0700); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(home, "tmp", "cgx-runtime-abc", ".cxx-private-lease"), "")
	write(t, filepath.Join(home, ".claude", "settings.json"), "{}")
	write(t, filepath.Join(home, ".bashrc"), "export A=1\n\n# Added by cgx\nalias grok='cgx'\nexport B=2\n")

	var calls []string
	res, err := Run(context.Background(), "grok", testOpts(home, &calls))
	if err != nil || !res.Complete() {
		t.Fatalf("err=%v residue=%v", err, res.Residue)
	}
	for _, gone := range []string{
		filepath.Join(cfg, "cgx.json"), filepath.Join(cfg, "cgx.json.sig"),
		filepath.Join(home, ".grok"), filepath.Join(home, ".cgx"),
		filepath.Join(home, ".cxx", "engines", "grok"), filepath.Join(home, "tmp", "cgx-runtime-abc"),
	} {
		if exists(gone) {
			t.Errorf("%s survived", gone)
		}
	}
	for _, kept := range []string{filepath.Join(cfg, "clx.json"), filepath.Join(home, ".claude", "settings.json"), filepath.Join(home, ".cxx", "engines", "claude", "keep")} {
		if !exists(kept) {
			t.Errorf("%s was removed", kept)
		}
	}
	rc, _ := os.ReadFile(filepath.Join(home, ".bashrc"))
	if string(rc) != "export A=1\n\nexport B=2\n" {
		t.Errorf("rc = %q", rc)
	}
	if strings.Join(calls, ",") != "shim:grok,alias:grok" {
		t.Errorf("calls = %v", calls)
	}

	// Second run is a clean no-op.
	res, err = Run(context.Background(), "grok", testOpts(home, &calls))
	if err != nil || !res.Complete() || len(res.Removed) != 0 {
		t.Fatalf("second run: err=%v removed=%v residue=%v", err, res.Removed, res.Residue)
	}
}

func TestDestroyClaudeKeepsUserMCPServers(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".claude.json"), `{"theme":"dark","mcpServers":{"fleet":{"a":1},"mine":{"b":2}}}`)
	write(t, filepath.Join(home, ".clx", "state", "managed-mcp.json"), `{"version":1,"names":["fleet"]}`)
	write(t, filepath.Join(home, ".claude", "projects", "p"), "x")
	var calls []string
	res, err := Run(context.Background(), "claude", testOpts(home, &calls))
	if err != nil || !res.Complete() {
		t.Fatalf("err=%v residue=%v", err, res.Residue)
	}
	b, _ := os.ReadFile(filepath.Join(home, ".claude.json"))
	if !strings.Contains(string(b), `"mine"`) || strings.Contains(string(b), `"fleet"`) || !strings.Contains(string(b), `"theme"`) {
		t.Errorf(".claude.json = %s", b)
	}
	if exists(filepath.Join(home, ".claude")) || exists(filepath.Join(home, ".clx")) {
		t.Error("claude homes survived")
	}
	if got := strings.Join(calls, ","); got != "shim:claude,alias:claude,npm:@anthropic-ai/claude-code" {
		t.Errorf("calls = %s", got)
	}
}

func TestCodexHomeOverrideHonouredAndRootRefused(t *testing.T) {
	home := t.TempDir()
	custom := filepath.Join(t.TempDir(), "ch")
	write(t, filepath.Join(custom, "auth.json"), "x")
	var calls []string
	opt := testOpts(home, &calls)
	opt.Getenv = func(k string) string { return map[string]string{"CODEX_HOME": custom}[k] }
	if res, err := Run(context.Background(), "codex", opt); err != nil || !res.Complete() || exists(custom) {
		t.Fatalf("err=%v residue=%v exists=%v", err, res.Residue, exists(custom))
	}
	opt.Getenv = func(k string) string { return map[string]string{"CODEX_HOME": "/"}[k] }
	res, _ := Run(context.Background(), "codex", opt)
	if res.Complete() {
		t.Error("CODEX_HOME=/ must be refused and reported")
	}
	if _, err := Run(context.Background(), "codex", Options{Home: "relative"}); err == nil {
		t.Error("relative home must be rejected")
	}
}

func TestMarker(t *testing.T) {
	home := t.TempDir()
	if Done(home, "grok", "r1") {
		t.Fatal("done before marking")
	}
	if err := MarkDone(home, "grok", "r1"); err != nil {
		t.Fatal(err)
	}
	if !Done(home, "grok", "r1") || Done(home, "grok", "r2") || Done(home, "claude", "r1") {
		t.Fatal("marker must match engine and request id exactly")
	}
}

func TestDestroyRefusesAnAncestorOfHome(t *testing.T) {
	parent := t.TempDir()
	home := filepath.Join(parent, "user")
	keep := filepath.Join(home, "documents", "keep")
	write(t, keep, "user data")
	var calls []string
	opt := testOpts(home, &calls)
	opt.Getenv = func(k string) string {
		if k == "CODEX_HOME" {
			return parent
		}
		return ""
	}
	res, err := Run(context.Background(), "codex", opt)
	if err != nil {
		t.Fatal(err)
	}
	if res.Complete() || !exists(keep) {
		t.Fatalf("ancestor deletion: residue=%v, user data exists=%v", res.Residue, exists(keep))
	}
}

func TestDestroyRefusesAnAncestorThroughParentSymlink(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "scope", "user")
	keep := filepath.Join(home, "documents", "keep")
	write(t, keep, "user data")
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	var calls []string
	opt := testOpts(home, &calls)
	opt.Getenv = func(k string) string {
		if k == "GROK_HOME" {
			return filepath.Join(alias, "scope")
		}
		return ""
	}
	res, err := Run(context.Background(), "grok", opt)
	if err != nil || res.Complete() || !exists(keep) {
		t.Fatalf("err=%v residue=%v user data exists=%v", err, res.Residue, exists(keep))
	}
}

func TestDestroyPreservesUnownedAndBusyTempDirectories(t *testing.T) {
	home := t.TempDir()
	unowned := filepath.Join(home, "tmp", "cgx-runtime-unowned")
	busy := filepath.Join(home, "tmp", "cgx-login-busy")
	write(t, filepath.Join(unowned, "keep"), "unowned")
	write(t, filepath.Join(busy, "keep"), "active")
	if err := os.Chmod(busy, 0700); err != nil {
		t.Fatal(err)
	}
	lease, err := ipc.TryAcquireSharedPath(filepath.Join(busy, ".cxx-private-lease"))
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	var calls []string
	res, err := Run(context.Background(), "grok", testOpts(home, &calls))
	if err != nil || res.Complete() || !exists(unowned) || !exists(busy) {
		t.Fatalf("err=%v residue=%v unowned=%v busy=%v", err, res.Residue, exists(unowned), exists(busy))
	}
}
