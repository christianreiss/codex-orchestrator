package main

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/buildinfo"
)

func TestGlobalAndNestedHelpBypassesManagedBoot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CXX_AGENT_PORTAL_SOCKET", "/missing/socket")
	commands := [][]string{{"housekeeping"}, {"housekeeping", "pin"}, {"native-entry"}, {"native-entry", "remove"}, {"communicator"}, {"communicator", "uninstall"}, {"daemon"}, {"daemon", "uninstall"}, {"cron"}, {"cron", "install"}, {"update"}, {"sync"}, {"agent", "list"}, {"agent", "service", "stop"}, {"portal", "leave"}, {"portal", "say"}, {"watchdog", "on"}, {"reboot", "disarm"}}
	for _, base := range commands {
		for _, help := range []string{"--help", "-h"} {
			args := append(append([]string{}, base...), help)
			var out, errout bytes.Buffer
			if code := run("cxx", args, &out, &errout); code != 0 || out.Len() == 0 || errout.Len() != 0 {
				t.Fatalf("%v: code=%d out=%s err=%s", args, code, &out, &errout)
			}
		}
	}
	entries, err := os.ReadDir(home)
	if err != nil || len(entries) != 0 {
		t.Fatalf("help wrote HOME: %v %v", entries, err)
	}
}

func TestHostControlDispatchThroughProgramNames(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	for _, name := range []string{"CDX_CONFIG_PATH", "CLX_CONFIG_PATH", "CGX_CONFIG_PATH", "CKX_CONFIG_PATH"} {
		t.Setenv(name, home+"/no-config")
	}
	savedVersion := buildinfo.Version
	t.Cleanup(func() { buildinfo.Version = savedVersion })
	for _, program := range []string{"cxx", "cdx", "clx", "cgx", "ckx", "cdx-0.7.2", "clx-0.7.2", "cgx-0.7.2", "ckx-0.7.2", "cxx-download-probe"} {
		for _, command := range []string{"watchdog", "reboot"} {
			t.Run(program+"/"+command, func(t *testing.T) {
				const beforeSetup = "before host configuration"
				buildinfo.Version = beforeSetup
				var out, diagnostics bytes.Buffer
				if code := run(program, []string{command, "--help"}, &out, &diagnostics); code != 0 || !strings.Contains(out.String(), "cxx "+command+" ") || diagnostics.Len() != 0 {
					t.Fatalf("help: code=%d stdout=%q stderr=%q", code, &out, &diagnostics)
				}
				if buildinfo.Version != beforeSetup {
					t.Fatal("help went through managed initialization")
				}
				out.Reset()
				if code := run(program, []string{command, "invalid-operation"}, &out, &diagnostics); code != 1 || out.Len() != 0 || !strings.Contains(diagnostics.String(), "cxx "+command+":") {
					t.Fatalf("invalid action: code=%d stdout=%q stderr=%q", code, &out, &diagnostics)
				}
				if buildinfo.Version != Version {
					t.Fatal("ordinary command skipped managed initialization")
				}
			})
		}
	}
}
