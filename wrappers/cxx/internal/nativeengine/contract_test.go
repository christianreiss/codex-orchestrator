package nativeengine_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/kimi"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/skillstore"
)

type engineStore struct {
	persona, binary, binEnv, missing string
	homeDir                          string
	stateDir, storeDir               func() (string, error)
	findCLI                          func() (string, error)
	skills                           func() (skillstore.Store, error)
	maintenance                      func(string) (*ipc.Lock, error)
	label                            string
}

// The derived on-disk names are shared with released binaries and installed
// state; pin them literally for each engine.
func TestEngineStorePathsAreFrozen(t *testing.T) {
	for _, e := range []engineStore{
		{persona: ".cgx", binary: "grok", binEnv: "CGX_GROK_BIN", missing: "Grok CLI missing; run cgx update", homeDir: ".grok", label: "Grok",
			stateDir: grok.StateDir, storeDir: grok.StoreDir, findCLI: grok.FindCLI, skills: grok.Skills, maintenance: grok.TryAcquireMaintenance},
		{persona: ".ckx", binary: "kimi", binEnv: "CKX_KIMI_BIN", missing: "Kimi CLI missing; run ckx update", homeDir: ".kimi-code", label: "Kimi",
			stateDir: kimi.StateDir, storeDir: kimi.StoreDir, findCLI: kimi.FindCLI, skills: kimi.Skills, maintenance: kimi.TryAcquireMaintenance},
	} {
		t.Run(e.binary, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("PATH", t.TempDir())
			t.Setenv("GROK_HOME", "")
			t.Setenv("KIMI_CODE_HOME", "")
			t.Setenv(e.binEnv, "")
			if got, _ := e.stateDir(); got != filepath.Join(home, e.persona, "state") {
				t.Fatalf("state dir %q", got)
			}
			if got, _ := e.storeDir(); got != filepath.Join(home, ".cxx", "engines", e.binary) {
				t.Fatalf("store dir %q", got)
			}
			if _, err := e.findCLI(); err == nil || err.Error() != e.missing {
				t.Fatalf("missing CLI error %v", err)
			}
			cli := filepath.Join(home, "vendor", e.binary)
			if err := os.MkdirAll(filepath.Dir(cli), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(cli, []byte("#!/bin/sh\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Join(home, e.persona, "state"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(home, e.persona, "state", e.binary+"-bin"), []byte(cli+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if got, err := e.findCLI(); err != nil || got != cli {
				t.Fatalf("recorded CLI %q %v", got, err)
			}
			store, _ := e.skills()
			if store.Root != filepath.Join(home, e.homeDir, "skills") || store.ManifestPath != filepath.Join(home, e.persona, "state", "skills.json") || store.Label != e.label {
				t.Fatalf("skill store %+v", store)
			}
			lock, err := e.maintenance(home)
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Release()
			if _, err := os.Stat(filepath.Join(home, e.persona+"-sessions.lock")); err != nil {
				t.Fatalf("maintenance lock path: %v", err)
			}
		})
	}
}
