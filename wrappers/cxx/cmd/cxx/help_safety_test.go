package main

import (
	"bytes"
	"os"
	"testing"
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
