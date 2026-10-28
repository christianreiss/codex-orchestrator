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

// Grok Build 1.0.70 `update --version <VERSION>` installs that version; only a
// root --version before any subcommand (or `version`) is a version request.
func TestNativeUpdateOptionsCannotBypassFleetInstall(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, args := range [][]string{
		{"update", "--version", "1.0.73"}, {"update", "--version=1.0.73"},
		{"--debug", "update", "--version", "1.0.73"}, {"install", "--version", "x"},
		{"upgrade", "--version", "x"}, {"update", "--check"}, {"update", "--alpha"},
		{"update", "--stable"}, {"update", "--force-reinstall"},
	} {
		if o, err := nativeOptions(args); err == nil || !strings.Contains(err.Error(), "fleet-managed") {
			t.Fatalf("%q bypassed fleet-managed install: %+v %v", args, o, err)
		}
	}
	for _, args := range [][]string{{"--version"}, {"version", "--json"}, {"--version", "update"}, {"update", "--version", "x", "--help"}} {
		if o, err := nativeOptions(args); err != nil || o.command != "run" {
			t.Fatalf("version/help %q refused: %+v %v", args, o, err)
		}
	}
}

func stubGrokCLI(t *testing.T) (marker string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("GROK_HOME", filepath.Join(home, ".grok"))
	marker = filepath.Join(home, "native-ran")
	cli := filepath.Join(home, "vendor-grok")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > '"+marker+"'\nprintf '%s\\n' \"$@\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CGX_GROK_BIN", cli)
	return marker
}

// Refusals run before signed config, leasing or a native exec, for both the
// native entry and `cgx run …` / `cgx <native command>`.
func TestManagedNativeRefusalsPrecedeConfigAndNativeExec(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"leader", "worker", "start"}, "separate managed auth/session lifecycle"},
		{[]string{"--debug", "leader", "worker", "start"}, "separate managed auth/session lifecycle"},
		{[]string{"leader", "worker", "controller", "--pool", "x"}, "separate managed auth/session lifecycle"},
		{[]string{"update", "--version", "1.0.73"}, "fleet-managed"},
		{[]string{"setup"}, "organization managed configuration"},
		{[]string{"setup", "--json"}, "organization managed configuration"},
		{[]string{"--debug", "setup"}, "organization managed configuration"},
		{[]string{"--force-login"}, "cgx login"},
		{[]string{"--oauth", "hello"}, "cgx login"},
		{[]string{"agent", "--reauth", "stdio"}, "cgx login"},
		{[]string{"agent", "----reauthenticate", "stdio"}, "cgx login"},
	} {
		for _, entry := range []struct {
			name string
			run  func([]string, *bytes.Buffer, *bytes.Buffer) int
		}{
			{"native", func(a []string, o, e *bytes.Buffer) int { return RunNative(a, o, e) }},
			{"cgx run", func(a []string, o, e *bytes.Buffer) int { return Run(append([]string{"run"}, a...), o, e) }},
		} {
			marker := stubGrokCLI(t)
			var out, stderr bytes.Buffer
			code := entry.run(tc.args, &out, &stderr)
			if code == 0 || !strings.Contains(stderr.String(), tc.want) {
				t.Fatalf("%s %q: code=%d stderr=%q", entry.name, tc.args, code, stderr.String())
			}
			if _, err := os.Stat(marker); err == nil {
				t.Fatalf("%s %q reached the native binary", entry.name, tc.args)
			}
		}
	}
	// `cgx install` / `cgx setup` reach the same managed run as native argv.
	for _, args := range [][]string{{"install"}, {"setup"}} {
		stubGrokCLI(t)
		var out, stderr bytes.Buffer
		if code := Run(args, &out, &stderr); code != 2 {
			t.Fatalf("cgx %q: code=%d stderr=%q", args, code, stderr.String())
		}
	}
}

func TestManagedNativeRefusalsKeepHelpVersionAndValues(t *testing.T) {
	for _, args := range [][]string{{"leader", "worker", "--help"}, {"setup", "--help"}, {"--force-login", "--help"}, {"--version", "update"}, {"agent", "--reauth", "stdio", "--help"}} {
		marker := stubGrokCLI(t)
		var out, stderr bytes.Buffer
		if code := RunNative(args, &out, &stderr); code != 0 || out.String() != strings.Join(args, "\n")+"\n" {
			t.Fatalf("%q: code=%d stdout=%q stderr=%q", args, code, out.String(), stderr.String())
		}
		if _, err := os.Stat(marker); err != nil {
			t.Fatalf("%q did not reach native help/version", args)
		}
	}
	for _, args := range [][]string{{"--model", "--force-login"}, {"-p", "--oauth"}, {"--print=--force-login"}, {"agent", "--model", "--reauth", "stdio"}, {"--add-dir", "setup"}, {"leader", "--debug-file", "worker", "list"}, {"leader", "list"}} {
		if refusal := managedNativeRefusal(args); refusal != "" {
			t.Fatalf("value %q refused: %s", args, refusal)
		}
	}
	// --execute words are a prompt (sent through --prompt-file), never native argv.
	for _, prompt := range [][]string{{"setup"}, {"worker", "start"}, {"update", "--version", "x"}, {"--force-login"}} {
		stubGrokCLI(t)
		var out, stderr bytes.Buffer
		Run(append([]string{"--execute"}, prompt...), &out, &stderr)
		for _, refusal := range []string{"separate managed", "fleet-managed", "organization managed", "cgx login"} {
			if strings.Contains(stderr.String(), refusal) {
				t.Fatalf("execute prompt %q refused as native argv: %s", prompt, stderr.String())
			}
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
