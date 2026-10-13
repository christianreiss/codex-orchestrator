package communicator

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestSelectSignedConfigKeepsHostBindingAndEnabledScope(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	for _, name := range []string{"CDX_CONFIG_PATH", "CLX_CONFIG_PATH", "CGX_CONFIG_PATH"} {
		t.Setenv(name, filepath.Join(root, name))
	}
	base := config.Config{SchemaVersion: 1, Engine: "codex", IssuedAt: "2026-10-13T00:00:00Z", Orchestrator: config.Orchestrator{BaseURL: "https://fixture.example", APIKey: "fixture-host-key", InstallationID: "fixture", CommunicatorProtocol: 1}, Host: config.Host{ID: 1, FQDN: "fixture.example", Secure: true}, Wrapper: config.Wrapper{Version: "0.9.77", Track: "stable", BinaryURL: "https://fixture.example/download", BinarySHA256: "0000000000000000000000000000000000000000000000000000000000000000"}}
	write := func(path string, cfg config.Config) {
		t.Helper()
		raw, err := json.Marshal(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path+".sig", ed25519.Sign(priv, raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	seedPath := filepath.Join(root, "seed.json")
	write(seedPath, base)
	seed, err := loadSigned(seedPath, pub)
	if err != nil {
		t.Fatal(err)
	}
	claudePath := filepath.Join(root, "active-claude.json")
	claude := base
	claude.Engine = "claude"
	write(claudePath, claude)
	for _, mode := range []string{"missing", "protocol-disabled", "suspended", "invalid-signature", "wrong-host", "wrong-server"} {
		t.Run(mode, func(t *testing.T) {
			candidate := base
			switch mode {
			case "protocol-disabled":
				candidate.Orchestrator.CommunicatorProtocol = 0
			case "suspended":
				candidate.Host.FleetDisabledEngines = []string{"codex"}
			case "wrong-host":
				candidate.Host.ID = 2
			case "wrong-server":
				candidate.Orchestrator.BaseURL = "https://other.example"
			}
			write(seedPath, candidate)
			if mode == "missing" {
				os.Remove(seedPath)
			}
			if mode == "invalid-signature" {
				os.WriteFile(seedPath+".sig", make([]byte, ed25519.SignatureSize), 0600)
			}
			got, err := selectSignedConfig(seed, []string{claudePath}, pub)
			if err != nil || got.Engine != "claude" {
				t.Fatalf("surviving signed scope not selected: cfg=%v err=%v", got != nil, err)
			}
		})
	}
	// An explicitly signed fleet rollback stays available when no scope enables
	// the communicator. Missing/corrupt/foreign files alone never grant fallback.
	rolledBack := base
	rolledBack.Orchestrator.CommunicatorProtocol = 0
	write(seedPath, rolledBack)
	rolledBack.Engine = "claude"
	write(claudePath, rolledBack)
	got, err := selectSignedConfig(seed, []string{claudePath}, pub)
	if err != nil || got.Orchestrator.CommunicatorProtocol != 0 {
		t.Fatalf("verified rollback lost: cfg=%v err=%v", got != nil, err)
	}
	os.Remove(seedPath)
	foreign := claude
	foreign.Host.FQDN = "foreign.example"
	write(claudePath, foreign)
	if _, err := selectSignedConfig(seed, []string{claudePath}, pub); err == nil {
		t.Fatal("foreign config selected after seed removal")
	}
	write(claudePath, claude)
	write(seedPath, base)
	// Reload snapshots of registered sync scopes concurrently with their removal
	// and reattachment; workers/downloads read the same immutable config pointer.
	s := &server{cfg: seed, jobs: map[string]syncJob{}, jobRefs: map[string]int{}}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				s.mu.Lock()
				s.jobs["active"] = syncJob{Engine: "claude", Config: claudePath}
				s.jobRefs["active"] = 1
				s.mu.Unlock()
				cfg, err := s.reloadConfig(pub)
				if err != nil {
					t.Error(err)
					return
				}
				s.mu.Lock()
				s.cfg = cfg
				delete(s.jobs, "active")
				delete(s.jobRefs, "active")
				s.mu.Unlock()
				_ = s.configSnapshot()
			}
		}()
	}
	wg.Wait()
}
