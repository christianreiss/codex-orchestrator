package operatorerror

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestHostnameMismatchExplainsNormalRepairBeforeAdvancedOverride(t *testing.T) {
	err := &HostnameMismatch{Current: "unfi", Expected: "unifi.son.je", Override: "CODEX_ALLOW_FQDN_MISMATCH"}
	summary, details := err.Diagnostic()
	text := summary + strings.Join(details, " ")
	for _, want := range []string{"unfi", "unifi.son.je", "short name \"unifi\"", "hostname -f", "cxx cron run"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q: %s", want, text)
		}
	}
	if strings.Contains(text, "ALLOW_FQDN_MISMATCH") {
		t.Fatal("normal repair recommends bypassing host verification")
	}
	if !strings.Contains(err.Error(), "CODEX_ALLOW_FQDN_MISMATCH=1 disables host-name verification") {
		t.Fatal(err)
	}
	wrapped := InStep("Configuration sync", fmt.Errorf("sync: %w", err))
	var got *HostnameMismatch
	if !errors.As(wrapped, &got) || got != err {
		t.Fatal("lost typed cause")
	}
	if InStep("anything", nil) != nil {
		t.Fatal("nil turned into a failure")
	}
}
