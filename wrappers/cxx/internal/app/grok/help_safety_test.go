package grok

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

// The help lists the overrides cgx actually reads, as ckx's help does.
func TestWrapperHelpListsGrokOverrides(t *testing.T) {
	var out bytes.Buffer
	PrintWrapperHelp(&out, terminalui.Caps{NoColor: true, Dumb: true, Columns: 200})
	for _, want := range []string{"CGX_CONFIG_PATH / CGX_GROK_BIN", "GROK_ALLOW_FQDN_MISMATCH=1"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("help misses %s:\n%s", want, out.String())
		}
	}
}

func TestOwnedOperationHelpAndUnexpectedArgumentsBypassConfiguration(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CGX_CONFIG_PATH", "/missing/config")
	for _, command := range []string{"uninstall", "--uninstall", "logout", "sync", "auth-sync", "update", "--update", "auth-upload-auto", "status", "doctor"} {
		for _, help := range []string{"--help", "-h"} {
			var out, errout bytes.Buffer
			if code := Run([]string{command, help}, &out, &errout); code != 0 || out.Len() == 0 || errout.Len() != 0 {
				t.Fatalf("%s %s: %d %s %s", command, help, code, &out, &errout)
			}
		}
		var out, errout bytes.Buffer
		if code := Run([]string{command, "unexpected"}, &out, &errout); code != 2 {
			t.Fatalf("%s unknown argument got %d: %s", command, code, &errout)
		}
	}
	entries, err := os.ReadDir(home)
	if err != nil || len(entries) != 0 {
		t.Fatalf("help wrote HOME: %v %v", entries, err)
	}
}

func TestLoginAndCronHelpNeverBeginManagedLifecycle(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, args := range [][]string{{"login", "--help"}, {"login", "retry", "-h"}, {"cron", "install", "--help"}, {"auth-reconcile", "--help"}} {
		var out, errout bytes.Buffer
		if code := Run(args, &out, &errout); code != 0 || out.Len() == 0 || errout.Len() != 0 {
			t.Fatalf("%v: %d %s %s", args, code, &out, &errout)
		}
	}
	entries, err := os.ReadDir(home)
	if err != nil || len(entries) != 0 {
		t.Fatalf("help wrote HOME: %v %v", entries, err)
	}
}
