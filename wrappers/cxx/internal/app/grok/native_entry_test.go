package grok

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
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
		o, err := nativeOptions([]string{command, "--native-option"})
		if err != nil || o.command != command || !reflect.DeepEqual(o.args, []string{"--native-option"}) {
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
