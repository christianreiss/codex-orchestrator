package claudeapp

import (
	"bytes"
	"context"
	"io"
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

func TestNativeMaintenanceCommandsSkipInteractiveLifecycle(t *testing.T) {
	for _, args := range [][]string{{"purge", "--dry-run"}, {"mcp", "list"}, {"doctor"}, {"--advisor", "opus", "plugin", "list"}} {
		_, positional, passthrough := invocationFlags(args, true)
		if !reflect.DeepEqual(positional, []string{"native-command"}) || !reflect.DeepEqual(passthrough, args) {
			t.Fatalf("maintenance routed as session: args=%v positional=%v pass=%v", args, positional, passthrough)
		}
	}
}

func TestNativeRequiredFlagValuesAreNotSessionFlags(t *testing.T) {
	for _, flag := range []string{"--advisor", "--max-turns", "--permission-prompt-tool", "--system-prompt-file", "--append-system-prompt-file", "--append-subagent-system-prompt", "--append-subagent-system-prompt-file"} {
		args := []string{flag, "--print", "--system-prompt", "--resume"}
		if nativeHeadless(args) || nativeResumed(args) {
			t.Fatalf("flag value classified as launch: %v", args)
		}
		if nativeInformation([]string{flag, "--help"}) {
			t.Fatalf("flag value classified as help: %s", flag)
		}
	}
}

func TestNativeServicesRefuseUnsupportedManagedLifecycleBeforeConfig(t *testing.T) {
	for _, command := range []string{"daemon", "remote-control", "rc", "remote", "bridge", "self-hosted-runner"} {
		for _, run := range []func([]string, io.Writer, io.Writer) int{RunNative, Run} {
			var out, errOut bytes.Buffer
			if exit := run([]string{command}, &out, &errOut); exit != 2 || !strings.Contains(errOut.String(), "cannot inherit managed authentication/settings") {
				t.Fatalf("%s: exit=%d out=%s err=%s", command, exit, out.String(), errOut.String())
			}
		}
		if unsupportedNativeService([]string{command, "--help"}) != "" || !isHelpPassthrough([]string{command, "--help"}) {
			t.Fatalf("help incorrectly refused: %s", command)
		}
	}
	for _, args := range [][]string{{"--", "daemon"}, {"--system-prompt", "daemon"}, {"--resume", "daemon"}, {"--channels", "a", "daemon"}, {"explain daemon"}} {
		if got := unsupportedNativeService(args); got != "" {
			t.Fatalf("literal value %v refused as %s", args, got)
		}
	}
}

func TestNativeUpdaterAndAuthRespectLeadingOptionValues(t *testing.T) {
	if !nativeInstallerCommand([]string{"--advisor", "opus", "update"}) {
		t.Fatal("leading options bypassed fleet version pin")
	}
	if nativeInstallerCommand([]string{"--advisor", "update"}) {
		t.Fatal("option value interpreted as installer")
	}
	args := []string{"--advisor", "opus", "auth", "logout"}
	_, pos, pass := invocationFlags(args, true)
	if !reflect.DeepEqual(pos, []string{"auth", "logout"}) || len(pass) != 0 || authMutationKind(args) != "logout" {
		t.Fatalf("native auth lost boundary: %v %v", pos, pass)
	}
}

func TestNativeSyncAliasIsNotWrapperSync(t *testing.T) {
	if unsupportedNativeService([]string{"sync"}) != "sync" {
		t.Fatal("native remote-control sync alias escaped service boundary")
	}
	f, pos, _ := invocationFlags([]string{"sync"}, false)
	if command, _ := resolveCommand(f, pos); command != "sync" {
		t.Fatal("wrapper sync changed")
	}
	f, pos, _ = invocationFlags([]string{"--execute", "daemon"}, false)
	if command, _ := resolveCommand(f, pos); command != "execute" {
		t.Fatal("wrapper prompt changed")
	}
}
