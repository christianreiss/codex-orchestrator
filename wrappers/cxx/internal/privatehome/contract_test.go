package privatehome_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/kimi"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/privatehome"
)

// The reaper is re-executed from the installed binary, which can be a newer
// release than the launcher that started it, so these names are frozen.
func TestReaperCommandsAreFrozen(t *testing.T) {
	if grok.PrivateReaperCommand != "__cxx-grok-private-reaper" || kimi.PrivateReaperCommand != "__cxx-kimi-private-reaper" {
		t.Fatalf("reaper commands changed: %q %q", grok.PrivateReaperCommand, kimi.PrivateReaperCommand)
	}
	if privatehome.LeaseName != ".cxx-private-lease" {
		t.Fatalf("lease name changed: %q", privatehome.LeaseName)
	}
}

// Engine destruction offers every leftover to Grok first, then Kimi; each
// engine must leave the other's temp prefix alone.
func TestEnginesLeaveForeignPrefixesAlone(t *testing.T) {
	for _, tc := range []struct {
		name   string
		remove func(string) (bool, error)
	}{
		{"cgx-runtime-x", kimi.RemoveIdlePrivateDirectory},
		{"cgx-login-x", kimi.RemoveIdlePrivateDirectory},
		{"ckx-runtime-x", grok.RemoveIdlePrivateDirectory},
		{"ckx-login-x", grok.RemoveIdlePrivateDirectory},
	} {
		dir := filepath.Join(t.TempDir(), tc.name)
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, privatehome.LeaseName), nil, 0600); err != nil {
			t.Fatal(err)
		}
		if removed, err := tc.remove(dir); removed || err != nil {
			t.Fatalf("%s: foreign prefix handled: %v %v", tc.name, removed, err)
		}
		if _, err := os.Stat(dir); err != nil {
			t.Fatalf("%s: foreign directory removed", tc.name)
		}
	}
}
