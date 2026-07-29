package claude

import (
	"os"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestGuardFQDN_AllowsMatch(t *testing.T) {
	hn, err := os.Hostname()
	if err != nil {
		t.Skip("no hostname")
	}
	cfg := &config.Config{Host: config.Host{FQDN: hn}}
	if err := GuardFQDN(cfg); err != nil {
		t.Fatalf("exact-match should allow: %v", err)
	}
}

func TestGuardFQDN_RejectsMismatch(t *testing.T) {
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "")
	cfg := &config.Config{Host: config.Host{FQDN: "definitely-not-this-host.example.invalid"}}
	err := GuardFQDN(cfg)
	if err == nil {
		t.Fatalf("mismatch should error")
	}
	if !strings.Contains(err.Error(), "does not match") {
		t.Errorf("err msg: %v", err)
	}
}

func TestGuardFQDN_OverrideEnvAllows(t *testing.T) {
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "1")
	cfg := &config.Config{Host: config.Host{FQDN: "wrong.example"}}
	if err := GuardFQDN(cfg); err != nil {
		t.Fatalf("override should allow: %v", err)
	}
}

func TestGuardFQDN_EmptyBakedAllows(t *testing.T) {
	if err := GuardFQDN(&config.Config{Host: config.Host{FQDN: ""}}); err != nil {
		t.Fatalf("empty baked FQDN should pass: %v", err)
	}
}

func TestGuardFQDN_NilAllows(t *testing.T) {
	if err := GuardFQDN(nil); err != nil {
		t.Fatalf("nil cfg should pass: %v", err)
	}
}

func TestGuardFQDN_SuffixMatch(t *testing.T) {
	hn, err := os.Hostname()
	if err != nil || hn == "" {
		t.Skip("no hostname")
	}
	cfg := &config.Config{Host: config.Host{FQDN: hn + ".prod.example"}}
	if err := GuardFQDN(cfg); err != nil {
		t.Fatalf("suffix match should pass: %v", err)
	}
}
