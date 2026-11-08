package grok

import (
	"bytes"
	"os"
	"testing"
)

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
