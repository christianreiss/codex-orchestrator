package claudeapp

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestNativeInvocationKeepsWrapperTokensAsVendorArguments(t *testing.T) {
	args := []string{"status", "--config", "literal.toml", "--update", "--execute", "prompt", "--minimal", "--", "--resume"}
	f, pos, pass := invocationFlags(args, true)
	if f.statusFlag || f.updateFlag || f.minimal || f.configPath != "" || f.executePrompt != "" || f.resumeFlag || len(pos) != 0 || !reflect.DeepEqual(pass, args) {
		t.Fatalf("native argv interpreted by wrapper: flags=%+v pos=%v pass=%v", f, pos, pass)
	}
	pass[0] = "changed"
	if args[0] != "status" {
		t.Fatal("native argument copy aliases caller argv")
	}
}
func TestNativeLaunchClassification(t *testing.T) {
	for _, tc := range []struct {
		args          []string
		print, resume bool
	}{
		{[]string{"-p", "hello"}, true, false},
		{[]string{"--print", "--resume=00000000-0000-4000-8000-000000000001", "hello"}, true, true},
		{[]string{"--continue"}, false, true},
		{[]string{"--resume"}, false, true},
		{[]string{"--", "--print", "--resume"}, false, false},
		{[]string{"--minimal", "hello"}, false, false},
	} {
		if nativeHeadless(tc.args) != tc.print || nativeResumed(tc.args) != tc.resume {
			t.Fatalf("classification %v", tc.args)
		}
	}
}
func TestNativeVersionAndHelpUseVendorOutputWithoutSignedConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nprintf '%s\n' \"$@\"\nexit 7\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)
	for _, args := range [][]string{{"--version"}, {"mcp", "--help"}, {"future-command", "--help"}, {"help"}} {
		var stdout, stderr bytes.Buffer
		if code := RunNative(args, &stdout, &stderr); code != 7 {
			t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
		}
		want := ""
		for _, arg := range args {
			want += arg + "\n"
		}
		if stdout.String() != want {
			t.Fatalf("argv changed: got %q want %q", stdout.String(), want)
		}
	}
}

func TestNativeAuthCommandsRetainJournalAndExactArguments(t *testing.T) {
	for _, args := range [][]string{{"auth", "login", "--method", "oauth"}, {"auth", "logout"}, {"login", "--method", "oauth"}, {"logout"}} {
		f, pos, pass := invocationFlags(args, true)
		sub, subArgs := resolveCommand(f, pos)
		if len(pass) != 0 || !reflect.DeepEqual(pos, args) || !commandOwnsAuthSession(sub, subArgs) || authMutationKind(args) == "" {
			t.Fatalf("auth journal bypass args=%v flags=%+v pos=%v pass=%v", args, f, pos, pass)
		}
	}
}
func TestNativeUpdaterCannotBypassFleetPin(t *testing.T) {
	for _, command := range []string{"install", "update", "upgrade"} {
		var stdout, stderr bytes.Buffer
		if code := RunNative([]string{command, "2.1.999"}, &stdout, &stderr); code != 2 || stdout.Len() != 0 {
			t.Fatalf("%s exit=%d stdout=%q stderr=%q", command, code, stdout.String(), stderr.String())
		}
		if nativeInstallerCommand([]string{command, "--help"}) {
			t.Fatalf("help for %s incorrectly blocked", command)
		}
	}
}

func TestNativeAuthMutationPassesExactVendorArgv(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path := filepath.Join(t.TempDir(), "claude")
	argvFile := filepath.Join(t.TempDir(), "argv")
	t.Setenv("CXX_NATIVE_TEST_ARGV", argvFile)
	t.Setenv("CLX_CLAUDE_BIN", path)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf '%s\n' \"$@\" > \"$CXX_NATIVE_TEST_ARGV\"\nexit 7\n"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"login", "--method", "oauth"}, {"logout"}, {"auth", "login", "--method", "oauth"}, {"auth", "logout"}} {
		var stdout, stderr bytes.Buffer
		if code := runClaudeAuthMutation(context.Background(), &config.Config{Host: config.Host{Secure: true}}, args, &stdout, &stderr, true); code != 7 {
			t.Fatalf("code=%d stderr=%q", code, stderr.String())
		}
		body, err := os.ReadFile(argvFile)
		if err != nil {
			t.Fatal(err)
		}
		forwarded := strings.Split(strings.TrimSuffix(string(body), "\n"), "\n")
		// The existing managed runtime auth overlay prepends its settings path.
		if len(forwarded) >= 2 && forwarded[0] == "--settings" {
			forwarded = forwarded[2:]
		}
		if !reflect.DeepEqual(forwarded, args) {
			t.Fatalf("native auth args changed: got %v args=%v", forwarded, args)
		}
	}
}
