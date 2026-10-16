package nativeargs

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCommandBoundaries(t *testing.T) {
	for _, tc := range []struct {
		engine string
		args   []string
		want   string
	}{
		{"codex", []string{"--image", "a.png", "login"}, ""},
		{"codex", []string{"--image", "-", "login"}, ""},
		{"codex", []string{"hello", "login"}, "login"},
		{"codex", []string{"--image", "exec", "resume", "logout"}, ""},
		{"codex", []string{"--image=a.png", "login"}, "login"},
		{"codex", []string{"-ia.png", "login"}, "login"},
		{"codex", []string{"--image", "a.png", "--model", "x", "login"}, "login"},
		{"codex", []string{"-mlogin", "exec"}, "exec"},
		{"codex", []string{"--", "login"}, ""},
		{"grok", []string{"--debug", "login"}, "login"},
		{"grok", []string{"--debug-file", "login"}, ""},
		{"grok", []string{"hello", "login"}, "login"},
		{"grok", []string{"--worktree", "login"}, ""},
		{"grok", []string{"-wlogin", "logout"}, "logout"},
		{"grok", []string{"--resume", "login"}, ""},
		{"grok", []string{"--resume", "--debug", "login"}, "login"},
		{"grok", []string{"--print", "update"}, ""},
		{"grok", []string{"-cphello", "login"}, "login"},
		{"grok", []string{"--allowed-tools", "update"}, ""},
		{"grok", []string{"--", "login"}, ""},
	} {
		got, _ := Command(tc.engine, tc.args)
		if got != tc.want {
			t.Errorf("%s %q: %q want %q", tc.engine, tc.args, got, tc.want)
		}
	}
}

func TestOpaqueValuesAndAliases(t *testing.T) {
	for _, flag := range []string{"-p", "--single", "--print", "--prompt-file", "--prompt-json", "--system-prompt-override", "--system-prompt", "--agents", "--allow", "--allowedTools", "--allowed-tools", "--deny", "--disallowedTools", "--tools", "--disallowed-tools", "--reasoning-effort", "--effort", "--json-schema", "--debug-file", "--sandbox", "--max-turns", "--worktree-ref", "--ref"} {
		if Has("grok", []string{flag, "--rules"}, "--rules") {
			t.Errorf("%s exposed its value", flag)
		}
	}
	if !Has("grok", []string{"-phello"}, "--single") || Value("grok", []string{"--print=--rules"}, "--single") != "--rules" {
		t.Fatal("headless aliases/inline values lost")
	}
	if !Has("grok", []string{"-cphello"}, "--single") || !Has("grok", []string{"-cphello"}, "--continue") {
		t.Fatal("short boolean/value group lost")
	}
	if Has("codex", []string{"--image", "exec", "resume"}, "--resume") {
		t.Fatal("image became resume")
	}
}

// Explicit opt-in runs only safe native help against a caller-selected binary.
// CI/unit tests do not discover provider binaries or touch real user homes.
func TestNativeHelpOracle(t *testing.T) {
	for _, engine := range []string{"codex", "grok"} {
		t.Run(engine, func(t *testing.T) {
			binary := os.Getenv("NATIVE_" + strings.ToUpper(engine) + "_ORACLE")
			if binary == "" {
				t.Skip("native help oracle not configured")
			}
			cases := []struct {
				args    []string
				heading string
			}{}
			if engine == "codex" {
				cases = []struct {
					args    []string
					heading string
				}{
					{[]string{"--image", "a.png", "login", "--help"}, "Codex CLI"},
					{[]string{"agents", "--help"}, "Browse all agent sessions on the shared local app-server daemon"},
					{[]string{"--image", "a.png", "agents", "--help"}, "Codex CLI"},
					{[]string{"--model", "agents", "--help"}, "Codex CLI"},
					{[]string{"--image", "-", "login", "--help"}, "Codex CLI"},
					{[]string{"hello", "login", "--help"}, "Manage login"},
					{[]string{"--image", "exec", "resume", "logout", "--help"}, "Codex CLI"},
					{[]string{"--image=a.png", "login", "--help"}, "Manage login"},
					{[]string{"-ia.png", "login", "--help"}, "Manage login"},
					{[]string{"--model", "login", "login", "--help"}, "Manage login"},
				}
			} else {
				cases = []struct {
					args    []string
					heading string
				}{
					{[]string{"--debug", "login", "--help"}, "Sign in to Grok"},
					{[]string{"--debug-file", "login", "--help"}, "Grok Build TUI"},
					{[]string{"--worktree", "login", "--help"}, "Grok Build TUI"},
					{[]string{"--print=--rules", "--help"}, "Grok Build TUI"},
					{[]string{"--allowed-tools", "update", "--help"}, "Grok Build TUI"},
					{[]string{"hello", "login", "--help"}, "Sign in to Grok"},
				}
			}
			for _, tc := range cases {
				home := t.TempDir()
				nativeHome := filepath.Join(home, "native")
				if err := os.Mkdir(nativeHome, 0700); err != nil {
					t.Fatal(err)
				}
				cmd := exec.Command(binary, tc.args...)
				cmd.Env = []string{"HOME=" + home, "CODEX_HOME=" + nativeHome, "GROK_HOME=" + nativeHome, "GROK_NO_AUTO_UPDATE=1", "PATH=" + os.Getenv("PATH")}
				out, err := cmd.Output()
				if err != nil || !strings.HasPrefix(string(out), tc.heading) {
					t.Fatalf("%q: %v %s", tc.args, err, out)
				}
				wantCommand := ""
				if tc.heading == "Manage login" || tc.heading == "Sign in to Grok" {
					wantCommand = "login"
				}
				if strings.HasPrefix(tc.heading, "Browse all agent sessions") {
					wantCommand = "agents"
				}
				got, _ := Command(engine, tc.args)
				if got != wantCommand {
					t.Fatalf("%q classifier %q disagrees with native heading %q", tc.args, got, tc.heading)
				}
			}
		})
	}
}

func TestNestedCodexResumeAfterSharedOptions(t *testing.T) {
	for _, args := range [][]string{{"exec", "--model", "foo", "resume", "native-id"}, {"e", "--image=a.png", "resume", "native-id"}, {"--model", "exec", "exec", "--profile", "work", "resume", "native-id"}} {
		command, at := CodexSessionCommand(args)
		if command != "resume" || args[at] != "resume" || !Resumed("codex", args) {
			t.Fatalf("nested resume lost: %q => %q %d", args, command, at)
		}
	}
	if Resumed("codex", []string{"exec", "--image", "a.png", "resume"}) {
		t.Fatal("image value became nested resume")
	}
}

func TestNativeAuthAndNestedResumeHelpOracle(t *testing.T) {
	for _, engine := range []string{"codex", "grok"} {
		binary := os.Getenv("NATIVE_" + strings.ToUpper(engine) + "_ORACLE")
		if binary == "" {
			continue
		}
		for _, args := range [][]string{{"--not-a-native-flag", "logout", "--help"}, {"logout", "extra", "--help"}, {"logout", "--not-a-native-flag", "--help"}} {
			home := t.TempDir()
			cmd := exec.Command(binary, args...)
			cmd.Env = []string{"HOME=" + home, "CODEX_HOME=" + home, "GROK_HOME=" + home, "GROK_NO_AUTO_UPDATE=1", "PATH=" + os.Getenv("PATH")}
			if err := cmd.Run(); err == nil {
				t.Fatalf("native %s accepted malformed auth help %q", engine, args)
			}
			if err := ValidateAuth(engine, args[:len(args)-1]); err == nil {
				t.Fatalf("managed %s discarded malformed auth %q", engine, args)
			}
		}
		if engine == "codex" {
			home := t.TempDir()
			args := []string{"exec", "--model", "foo", "resume", "01234567-89ab-4cde-8fab-0123456789ab", "--help"}
			cmd := exec.Command(binary, args...)
			cmd.Env = []string{"HOME=" + home, "CODEX_HOME=" + home, "PATH=" + os.Getenv("PATH")}
			out, err := cmd.Output()
			if err != nil || !strings.HasPrefix(string(out), "Resume a previous session") {
				t.Fatalf("nested resume oracle: %v %s", err, out)
			}
		}
	}
}
