package nativeargs

import (
	"encoding/json"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
)

// Captured from every public native 0.169.0 help scope, including nested
// utility/refused services; no account or running native session was used.
func TestCodex0169AllHelpValueOptions(t *testing.T) {
	raw, err := os.ReadFile("testdata/codex-0.169-value-options.json")
	if err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		Version  string              `json:"version"`
		Commands map[string][]string `json:"commands"`
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil || snapshot.Version != "0.169.0" {
		t.Fatalf("invalid native snapshot: %v", err)
	}
	for scope, options := range snapshot.Commands {
		for _, option := range options {
			assertValueOption(t, strings.Fields(scope), option)
		}
		if binary := os.Getenv("NATIVE_CODEX_ORACLE"); binary != "" {
			run := exec.Command(binary, append(strings.Fields(scope), "--help")...)
			home := t.TempDir()
			run.Env = []string{"HOME=" + home, "CODEX_HOME=" + home, "PATH=" + os.Getenv("PATH")}
			out, err := run.Output()
			if err != nil {
				t.Fatalf("%s --help: %v", scope, err)
			}
			line := regexp.MustCompile(`^\s+(?:-[A-Za-z], )?--[A-Za-z][A-Za-z0-9_-]* \[?<`)
			for _, raw := range strings.Split(string(out), "\n") {
				if !line.MatchString(raw) {
					continue
				}
				option := strings.TrimSpace(raw)
				if cut := strings.Index(option, "  "); cut > 0 {
					option = option[:cut]
				}
				assertValueOption(t, strings.Fields(scope), option)
			}
		}
	}
	if Has("codex", []string{"exec-server", "--chatgpt-account-id", "--remote"}, "--remote") {
		t.Fatal("account ID became a remote flag")
	}
	if got := UnsupportedService("codex", []string{"exec-server", "--chatgpt-account-id", "login"}); got != "exec-server" {
		t.Fatalf("executor escaped refusal: %q", got)
	}
	if command, _ := Command("codex", []string{"--trust", "exec"}); command != "exec" {
		t.Fatalf("zero-arity trust consumed the command: %q", command)
	}
}

func TestKimi262OpaqueScopedOptionsAndAliases(t *testing.T) {
	for _, tc := range []struct {
		args        []string
		flag, value string
		at          int
	}{
		{[]string{"provider", "catalog", "list", "--filter", "login"}, "--filter", "login", 3},
		{[]string{"provider", "catalog", "list", "--url", "--auto"}, "--url", "--auto", 3},
		{[]string{"provider", "catalog", "add", "--api-key", "--auto"}, "--api-key", "--auto", 3},
		{[]string{"provider", "catalog", "add", "--default-model", "exec-server"}, "--default-model", "exec-server", 3},
		{[]string{"provider", "catalog", "add", "--base-url", "--environment"}, "--base-url", "--environment", 3},
		{[]string{"provider", "catalog", "add", "--url", "--auto-approve"}, "--url", "--auto-approve", 3},
		{[]string{"exec-server", "--listen", "--auto"}, "--listen", "--auto", 1},
		{[]string{"__update_download", "--channel", "--auto"}, "--channel", "--auto", 1},
	} {
		name, value, end := Option("kimi", tc.args, tc.at)
		if name != tc.flag || value != tc.value || end != tc.at+1 {
			t.Fatalf("%q: %s %s %d", tc.args, name, value, end)
		}
		if Has("kimi", tc.args, tc.value) {
			t.Fatalf("%q: value became an option", tc.args)
		}
	}
	for _, args := range [][]string{{"-r"}, {"--resume", "session_id"}, {"-C"}} {
		if !Resumed("kimi", args) {
			t.Fatalf("resume alias lost: %q", args)
		}
	}
	for _, flag := range []string{"--yes", "--auto-approve"} {
		if !Has("kimi", []string{flag}, "--yolo") || Has("kimi", []string{flag}, "--auto") {
			t.Fatalf("%s no longer means Ask When Needed", flag)
		}
	}
	for _, args := range [][]string{{"-p", "--resume"}, {"provider", "catalog", "list", "--url", "--resume"}, {"-S", "session_id", "provider", "list"}} {
		if Resumed("kimi", args) {
			t.Fatalf("opaque data became resume: %q", args)
		}
	}
}

func TestKimi262UnsupportedLifecycleBoundaries(t *testing.T) {
	for _, args := range [][]string{{"exec-server"}, {"exec-server", "--listen", "stdio"}, {"__plugin_run_node", "entry.js"}, {"__update_download", "2.6.2"}, {"--environment", "remote"}, {"--environment-cwd", "/work"}} {
		if got := UnsupportedService("kimi", args); got != args[0] {
			t.Fatalf("%q: refusal %q", args, got)
		}
	}
	for _, args := range [][]string{{"-p", "exec-server"}, {"--model", "__plugin_run_node"}, {"provider", "catalog", "add", "--default-model", "exec-server"}, {"provider", "catalog", "list", "--filter", "--environment"}, {"--", "exec-server"}} {
		if got := UnsupportedService("kimi", args); got != "" {
			t.Fatalf("%q: opaque data refused as %q", args, got)
		}
	}
}

func TestKimi262NativeHelpOptionOracle(t *testing.T) {
	binary := os.Getenv("NATIVE_KIMI_ORACLE")
	if binary == "" {
		t.Skip("native help oracle not configured")
	}
	raw, err := os.ReadFile("testdata/kimi-help.json")
	if err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		Commands map[string]string `json:"commands"`
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatal(err)
	}
	line := regexp.MustCompile(`^\s+(?:-[A-Za-z], )?(--[A-Za-z][A-Za-z0-9_-]*)(?:\s+(<[^>]+>|\[[^]]+\]))?`)
	for scope := range snapshot.Commands {
		run := exec.Command(binary, append(strings.Fields(scope), "--help")...)
		home := t.TempDir()
		run.Env = []string{"HOME=" + home, "KIMI_CODE_HOME=" + home, "PATH=" + os.Getenv("PATH")}
		out, err := run.Output()
		if err != nil {
			t.Fatalf("%s --help: %v", scope, err)
		}
		for _, raw := range strings.Split(string(out), "\n") {
			match := line.FindStringSubmatch(raw)
			if match == nil {
				continue
			}
			args := append(strings.Fields(scope), match[1], "value", "second")
			at := len(strings.Fields(scope))
			_, value, end := Option("kimi", args, at)
			want := at
			if match[2] != "" {
				want++
				if strings.Contains(match[2], "...") {
					want++
				}
			}
			if end != want || (want > at && value != "value") {
				t.Fatalf("%s %s: value=%q end=%d want=%d", scope, match[1], value, end, want)
			}
		}
	}
}
