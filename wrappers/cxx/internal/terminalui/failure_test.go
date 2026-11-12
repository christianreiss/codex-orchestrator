package terminalui

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/operatorerror"
)

func TestFailureKeepsHostIdentitiesAndRecoveryAtEveryWidth(t *testing.T) {
	expected := "unifi." + strings.Repeat("long-domain-", 12) + "example"
	err := operatorerror.InStep("Configuration sync", fmt.Errorf("sync: %w", &operatorerror.HostnameMismatch{Current: "unfi", Expected: expected, Override: "CODEX_ALLOW_FQDN_MISMATCH"}))
	for _, width := range []int{20, 40, 80, 120} {
		for _, tty := range []bool{false, true} {
			var out bytes.Buffer
			PrintFailure(&out, Caps{IsTTY: tty, Dumb: !tty, Columns: width}, "cdx", "cron", err)
			text := out.String()
			compact := strings.Join(strings.Fields(text), "")
			for _, part := range []string{"unfi", expected, "hostname-f", "cxxcronrun"} {
				if !strings.Contains(compact, part) {
					t.Fatalf("width %d tty=%v lost %q:\n%s", width, tty, part, text)
				}
			}
			if strings.Contains(text, "baked") || strings.Contains(text, "FQDN_MISMATCH") || strings.Contains(text, "...") {
				t.Fatalf("technical/bounded message:\n%s", text)
			}
		}
	}
}

func TestFailureReportsIndependentJoinedCauses(t *testing.T) {
	var out bytes.Buffer
	PrintFailure(&out, Caps{}, "cxx", "cron", errors.Join(errors.New("download unavailable"), errors.New("version report rejected")))
	if !strings.Contains(out.String(), "download unavailable") || !strings.Contains(out.String(), "version report rejected") {
		t.Fatal(out.String())
	}
}

func TestFailureSanitizesTerminalControlsAndKeepsFullUnknownCause(t *testing.T) {
	var out bytes.Buffer
	cause := strings.Repeat("important detail ", 50) + "FINAL-RECOVERY-INSTRUCTION"
	PrintFailure(&out, Caps{}, "cdx", "cron", errors.New("\x1b[31m"+cause))
	if strings.Contains(out.String(), "\x1b") || !strings.Contains(out.String(), "FINAL-RECOVERY-INSTRUCTION") {
		t.Fatal(out.String())
	}
}

func TestFailureKeepsEveryCauseInsideWrappedJoinedStep(t *testing.T) {
	var out bytes.Buffer
	err := operatorerror.InStep("Configuration sync", fmt.Errorf("sync: %w", errors.Join(&operatorerror.HostnameMismatch{Current: "unfi", Expected: "unifi.son.je"}, errors.New("report endpoint unavailable"))))
	PrintFailure(&out, Caps{}, "cdx", "cron", err)
	for _, want := range []string{"unfi", "unifi.son.je", "report endpoint unavailable", "Configuration sync failed"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("lost %q: %s", want, out.String())
		}
	}
}

func TestFailureUsesTheFailedSchedulingActionForRetry(t *testing.T) {
	var out bytes.Buffer
	PrintFailure(&out, Caps{}, "cxx", "cron install", errors.New("permission denied"))
	if !strings.Contains(out.String(), "retry: cxx cron install") || strings.Contains(out.String(), "retry: cxx cron run") {
		t.Fatal(out.String())
	}
}
