package grok

import (
	"fmt"
	"os"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// GuardFQDN refuses to proceed when the baked cfg.Host.FQDN doesn't match the
// runtime hostname, so a cloned host never syncs or leases as its original.
// Suffix matches count (a baked "alpha.example.com" matches the short hostname
// "alpha"). Override with GROK_ALLOW_FQDN_MISMATCH=1.
func GuardFQDN(cfg *config.Config) error {
	if cfg == nil || strings.TrimSpace(cfg.Host.FQDN) == "" || os.Getenv("GROK_ALLOW_FQDN_MISMATCH") == "1" {
		return nil
	}
	real, err := os.Hostname()
	if err != nil || strings.TrimSpace(real) == "" {
		return nil
	}
	baked := strings.ToLower(strings.TrimSpace(cfg.Host.FQDN))
	got := strings.ToLower(strings.TrimSpace(real))
	if baked == got || strings.HasSuffix(got, "."+baked) || strings.HasSuffix(baked, "."+got) ||
		strings.HasPrefix(baked, got+".") || strings.HasPrefix(got, baked+".") {
		return nil
	}
	return fmt.Errorf("hostname %q does not match baked FQDN %q (set GROK_ALLOW_FQDN_MISMATCH=1 to override)", real, cfg.Host.FQDN)
}
