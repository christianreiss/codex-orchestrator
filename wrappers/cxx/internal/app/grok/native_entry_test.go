package grok

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNativeOptionsPreserveCLIGrammar(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, argv := range [][]string{
		{"status"}, {"sync"}, {"resume", "title"},
		{"--config", "native.toml", "--print", "hello"},
		{"--execute", "prompt"}, {"--", "login"},
	} {
		o, err := nativeOptions(argv)
		if err != nil || o.command != "run" || !reflect.DeepEqual(o.args, argv) {
			t.Fatalf("native %q interpreted as wrapper command: %+v, %v", argv, o, err)
		}
	}
	for _, command := range []string{"update", "upgrade", "install"} {
		if _, err := nativeOptions([]string{command}); err == nil {
			t.Fatalf("native %s bypassed managed version ownership", command)
		}
	}
	for _, command := range []string{"login", "logout"} {
		o, err := nativeOptions([]string{command, "--debug"})
		if err != nil || o.command != command || !reflect.DeepEqual(o.args, []string{"--debug"}) {
			t.Fatalf("native %s lost central auth owner: %+v %v", command, o, err)
		}
	}
}

func TestNativeFlagClassificationIgnoresLiteralValues(t *testing.T) {
	for _, argv := range [][]string{
		{"--", "--no-leader"}, {"--model", "--no-leader"}, {"--prompt-json", "--no-leader"},
	} {
		if nativeAnyFlag(argv, "--no-leader", "--leader-socket") {
			t.Fatalf("native literal value interpreted as leader flag: %q", argv)
		}
	}
	if !nativeAnyFlag([]string{"--leader-socket=/private/grok.sock"}, "--leader-socket") {
		t.Fatal("native equals-form leader socket ignored")
	}
}

func TestNativeVersionDoesNotRequireFleetConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("GROK_HOME", filepath.Join(home, ".grok"))
	cli := filepath.Join(home, "vendor-grok")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CGX_GROK_BIN", cli)
	var stdout, stderr bytes.Buffer
	if code := RunNative([]string{"--version"}, &stdout, &stderr); code != 0 || stdout.String() != "--version\n" {
		t.Fatalf("native version: code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

func TestNativeOptionsProtectPinnedInstallerAndKeepDiagnostics(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, command := range []string{"update", "upgrade", "install"} {
		if _, err := nativeOptions([]string{command}); err == nil {
			t.Fatalf("native %s bypassed pinned installer", command)
		}
		if o, err := nativeOptions([]string{command, "--help"}); err != nil || !reflect.DeepEqual(o.args, []string{command, "--help"}) {
			t.Fatalf("native %s help blocked: %+v %v", command, o, err)
		}
	}
}

func TestNativeOptionsDoNotAliasCallerArguments(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	args := []string{"--config", "local.toml", "--print", "canary"}
	o, err := nativeOptions(args)
	if err != nil {
		t.Fatal(err)
	}
	o.args[0] = "changed"
	if args[0] != "--config" {
		t.Fatal("native arguments share caller storage")
	}
}

func TestNativeGlobalOptionsKeepManagedAuthAndUpdates(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, command := range []string{"login", "logout", "update", "upgrade", "install"} {
		for _, prefix := range [][]string{{"--debug"}, {"--debug-file", "update"}, {"hello", "--debug"}} {
			args := append(append([]string{}, prefix...), command)
			o, err := nativeOptions(args)
			if command == "login" || command == "logout" {
				if err != nil || o.command != command {
					t.Fatalf("%q: %+v %v", args, o, err)
				}
			} else if err == nil {
				t.Fatalf("%q escaped managed update", args)
			}
			help := append(args, "--help")
			if o, err := nativeOptions(help); err != nil || o.command != "run" || !isHelpPassthrough(o.args) {
				t.Fatalf("help %q blocked: %+v %v", help, o, err)
			}
		}
	}
	for _, args := range [][]string{{"--debug-file", "login"}, {"--worktree", "logout"}, {"--print", "update"}, {"--", "login"}} {
		o, err := nativeOptions(args)
		if err != nil || o.command != "run" {
			t.Fatalf("value %q became managed command: %+v %v", args, o, err)
		}
	}
}

func TestNativeServiceRefusalPrecedesConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, args := range [][]string{{"agent"}, {"agent", "--no-leader"}, {"agent", "--model", "stdio"}, {"--debug", "cursor-worker", "start"}, {"worker", "start"}, {"--add-dir", "login", "worker", "controller"}, {"--leader-socket", "/unmanaged/leader.sock"}, {"agent", "--agent-profile", "leader", "serve"}, {"agent", "headless"}, {"agent", "leader"}} {
		var out, stderr bytes.Buffer
		if code := RunNative(args, &out, &stderr); code != 2 || !strings.Contains(stderr.String(), "separate managed auth/session lifecycle") {
			t.Fatalf("%q: %d %s", args, code, stderr.String())
		}
	}
}

func TestNativeAuthRejectsUnknownAndTrailingArguments(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, args := range [][]string{{"--not-a-native-flag", "logout"}, {"--not-a-native-flag", "login"}, {"logout", "extra"}, {"logout", "--not-a-native-flag"}, {"logout", "--model", "fixture"}} {
		if o, err := nativeOptions(args); err == nil {
			t.Fatalf("malformed native auth %q routed to %+v", args, o)
		}
	}
	for _, args := range [][]string{{"--version", "logout"}, {"--debug", "--version", "login"}} {
		if o, err := nativeOptions(args); err != nil || o.command != "run" {
			t.Fatalf("version diagnostic became auth: %q %+v %v", args, o, err)
		}
	}
}
