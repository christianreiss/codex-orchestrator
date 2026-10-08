package codexapp

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNativeInvocationPreservesArgumentsAndBypassesWrapperGrammar(t *testing.T) {
	for _, args := range [][]string{
		{"status"}, {"update"}, {"doctor"}, {"profile", "work"}, {"work"},
		{"--status"}, {"--update"},
		{"--execute", "literal prompt"}, {"--resume", "session"},
		{"--config", "approval_policy=\"never\"", "--", "status"},
		{"exec", "--json", "exact prompt"}, {"resume", "native-session"},
	} {
		t.Run(args[0], func(t *testing.T) {
			f, positional, passthrough := invocationFlags(args, true)
			if !reflect.DeepEqual(f, flags{}) {
				t.Fatalf("interpreted native wrapper flags: %+v", f)
			}
			sub, subArgs := resolveCommand(f, positional)
			if sub != "run" || len(subArgs) != 0 {
				t.Fatalf("native command dispatched to %q %v", sub, subArgs)
			}
			if !reflect.DeepEqual(passthrough, args) {
				t.Fatalf("native argv = %v, want %v", passthrough, args)
			}
			passthrough[0] = "changed"
			if args[0] == "changed" {
				t.Fatal("native argv shares caller storage")
			}
		})
	}
}

func TestWrapperInvocationStillParsesStatus(t *testing.T) {
	f, positional, passthrough := invocationFlags([]string{"--status"}, false)
	sub, _ := resolveCommand(f, positional)
	if sub != "status" || len(passthrough) != 0 {
		t.Fatalf("wrapper dispatch = %q %v", sub, passthrough)
	}
}

func TestNativeDiagnosticsUseVendorWithoutFleetConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	cli := filepath.Join(home, "vendor-codex")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\nexit 7\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", cli)
	for _, args := range [][]string{{"--version"}, {"-V"}, {"--help"}, {"--config", "model=fixture", "--help"}} {
		var out, errOut bytes.Buffer
		if code := RunNative(args, &out, &errOut); code != 7 || out.String() != strings.Join(args, "\n")+"\n" {
			t.Fatalf("native %v: code %d output %q stderr %q", args, code, out.String(), errOut.String())
		}
	}
}

func TestNativeAuthCommandsKeepManagedBoundaryAndGlobalArgs(t *testing.T) {
	for _, args := range [][]string{{"login", "status"}, {"logout"}, {"-c", "model=fixture", "login", "--device-auth"}, {"--profile", "work", "logout"}} {
		f, pos, pass := invocationFlags(args, true)
		sub, _ := resolveCommand(f, pos)
		if sub != nativeSubcommand(args) || !reflect.DeepEqual(pass, args) {
			t.Fatalf("auth command %v routed to %s %v", args, sub, pass)
		}
	}
	if got := nativeSubcommand([]string{"--model", "login", "exec", "prompt"}); got != "exec" {
		t.Fatalf("flag value routed as auth command: %s", got)
	}
}
