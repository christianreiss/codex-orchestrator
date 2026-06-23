package codex

import (
	"os"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
)

func TestGuardFQDN_AllowsMatch(t *testing.T) {
	hn, err := os.Hostname()
	if err != nil {
		t.Skip("no hostname available")
	}
	cfg := &config.Config{Host: config.Host{FQDN: hn}}
	if err := GuardFQDN(cfg); err != nil {
		t.Fatalf("exact-match should allow: %v", err)
	}
}

func TestGuardFQDN_RejectsMismatch(t *testing.T) {
	t.Setenv("CODEX_ALLOW_FQDN_MISMATCH", "")
	cfg := &config.Config{Host: config.Host{FQDN: "definitely-not-this-host.example.invalid"}}
	err := GuardFQDN(cfg)
	if err == nil {
		t.Fatalf("mismatch should error")
	}
	if !strings.Contains(err.Error(), "does not match") {
		t.Errorf("error message should mention mismatch: %v", err)
	}
}

func TestGuardFQDN_OverrideEnvAllows(t *testing.T) {
	t.Setenv("CODEX_ALLOW_FQDN_MISMATCH", "1")
	cfg := &config.Config{Host: config.Host{FQDN: "wrong.example"}}
	if err := GuardFQDN(cfg); err != nil {
		t.Fatalf("override should allow: %v", err)
	}
}

func TestGuardFQDN_EmptyBakedFQDNAllows(t *testing.T) {
	cfg := &config.Config{Host: config.Host{FQDN: ""}}
	if err := GuardFQDN(cfg); err != nil {
		t.Fatalf("empty baked FQDN should pass: %v", err)
	}
}

func TestGuardFQDN_NilConfigAllows(t *testing.T) {
	if err := GuardFQDN(nil); err != nil {
		t.Fatalf("nil cfg should pass: %v", err)
	}
}

func TestGuardFQDN_SuffixMatch(t *testing.T) {
	// Short runtime hostname; baked FQDN extends it.
	hn, err := os.Hostname()
	if err != nil || hn == "" {
		t.Skip("no hostname")
	}
	cfg := &config.Config{Host: config.Host{FQDN: hn + ".prod.example"}}
	if err := GuardFQDN(cfg); err != nil {
		t.Fatalf("suffix match (baked extends short hostname) should pass: %v", err)
	}
}

func TestGuardFQDN_PrefixMatch(t *testing.T) {
	hn, err := os.Hostname()
	if err != nil || hn == "" {
		t.Skip("no hostname")
	}
	// Reverse: baked short, runtime FQDN. Only meaningful if runtime contains a dot.
	if !strings.Contains(hn, ".") {
		baked := strings.SplitN(hn, ".", 2)[0]
		cfg := &config.Config{Host: config.Host{FQDN: baked}}
		if err := GuardFQDN(cfg); err != nil {
			t.Fatalf("baked short matches runtime FQDN prefix: %v", err)
		}
	}
}
