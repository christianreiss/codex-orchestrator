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

func TestNativeCommandAliasesAndCurrentOptionValues(t *testing.T) {
	for _, command := range []string{"e", "a"} {
		if isProfileShorthand(command) || !isHelpPassthrough([]string{command, "--help"}) {
			t.Fatalf("native alias treated as profile: %s", command)
		}
	}
	for _, flag := range []string{"--add-dir", "--remote-auth-token-env"} {
		if got := nativeSubcommand([]string{flag, "login", "e", "prompt"}); got != "e" {
			t.Fatalf("value became auth command: %s => %s", flag, got)
		}
	}
	if !nativeHeadless([]string{"e", "prompt"}) {
		t.Fatal("exec alias not headless")
	}
	if reservedCodexSubcommands["mcp-server"] {
		t.Fatal("removed MCP server command still advertised")
	}
}

func TestVariadicImagesAreNeverManagedCommands(t *testing.T) {
	for _, name := range []string{"login", "logout", "exec", "e", "resume"} {
		args := []string{"--image", "first.png", name}
		_, pos, pass := invocationFlags(args, true)
		if len(pos) != 0 || nativeSubcommand(args) != "" || nativeHeadless(args) || !reflect.DeepEqual(pass, args) {
			t.Fatalf("image %s became command: %q %q", name, pos, pass)
		}
		if !isHelpPassthrough(append(args, "--help")) {
			t.Fatalf("image %s hid root help", name)
		}
	}
	for _, args := range [][]string{{"--image=first.png", "login"}, {"-ifirst.png", "login"}} {
		if nativeSubcommand(args) != "login" {
			t.Fatalf("inline image swallowed command: %q", args)
		}
	}
	if isHelpPassthrough([]string{"exec", "--model", "--help"}) {
		t.Fatal("subcommand help scanner stole a value")
	}
}

func TestUnsupportedNativeServicesFailBeforeConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, args := range [][]string{{"remote-control"}, {"--model", "fixture", "exec-server"}, {"app-server", "--listen", "unix:///tmp/unmanaged.sock"}, {"--remote", "unix:///tmp/unmanaged.sock"}} {
		var out, stderr bytes.Buffer
		if code := RunNative(args, &out, &stderr); code != 2 || !strings.Contains(stderr.String(), "separate managed auth/session lifecycle") {
			t.Fatalf("%q: %d %s", args, code, stderr.String())
		}
	}
}

func TestNativePromptBeforeSubcommandRetainsHelpAndAuth(t *testing.T) {
	f, pos, pass := invocationFlags([]string{"hello", "login", "--help"}, true)
	if !f.helpPassthrough || len(pos) != 1 || pos[0] != "login" || len(pass) != 3 {
		t.Fatalf("prompt-prefixed login lost help/auth boundary: %+v %q %q", f, pos, pass)
	}
}
