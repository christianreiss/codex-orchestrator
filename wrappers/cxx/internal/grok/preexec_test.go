package grok

import (
	"os"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestGuardFQDNAcceptsMatchingNamesAndRefusesClones(t *testing.T) {
	host, err := os.Hostname()
	if err != nil || host == "" {
		t.Skip("no hostname")
	}
	cfg := &config.Config{}
	for _, fqdn := range []string{"", host, strings.ToUpper(host), host + ".fleet.example"} {
		cfg.Host.FQDN = fqdn
		if err := GuardFQDN(cfg); err != nil {
			t.Fatalf("%q refused: %v", fqdn, err)
		}
	}
	cfg.Host.FQDN = "someone-else.invalid"
	if err := GuardFQDN(cfg); err == nil || !strings.Contains(err.Error(), "GROK_ALLOW_FQDN_MISMATCH") {
		t.Fatalf("clone accepted: %v", err)
	}
	t.Setenv("GROK_ALLOW_FQDN_MISMATCH", "1")
	if err := GuardFQDN(cfg); err != nil {
		t.Fatalf("override ignored: %v", err)
	}
}
