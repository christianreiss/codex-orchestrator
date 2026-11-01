package nativeargs

import (
	"encoding/json"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
)

type grokHelpCorpus struct {
	Version  string `json:"version"`
	Commands []struct {
		Path []string `json:"path"`
		Help string   `json:"help"`
	} `json:"commands"`
}

func grokCorpus(t *testing.T) grokHelpCorpus {
	t.Helper()
	data, err := os.ReadFile("testdata/grok-1.0.70-help.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus grokHelpCorpus
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	if corpus.Version != "1.0.70" || len(corpus.Commands) != 84 {
		t.Fatal("incomplete pinned native help corpus")
	}
	return corpus
}

var grokValueHelp = regexp.MustCompile(`^\s*(?:(-[A-Za-z]), )?(--[A-Za-z][A-Za-z0-9_-]*) (\[?)<[^>]+>\]?`)

func assertGrokHelpValues(t *testing.T, path []string, help string) {
	t.Helper()
	for _, line := range strings.Split(help, "\n") {
		match := grokValueHelp.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		short, long, isOptional := match[1], match[2], match[3] == "["
		for _, flag := range []string{long, short} {
			if flag == "" {
				continue
			}
			sentinelArgs := append(append([]string{}, path...), flag, "--", "--help")
			_, sentinelValue, sentinelEnd := Option("grok", sentinelArgs, len(path))
			if sentinelValue != "" || sentinelEnd != len(path) || Has("grok", sentinelArgs, "--help") {
				t.Errorf("%q %s crossed sentinel", path, flag)
			}
			for _, value := range []string{"first", "-", "--help", "--version", "login", "worker", "stdio", "--resume"} {
				args := append(append([]string{}, path...), flag, value)
				name, got, end := Option("grok", args, len(path))
				// Optional values stop before an actual flag. Required values
				// stay opaque even when native later rejects their syntax.
				consumes := !isOptional || !strings.HasPrefix(value, "-") || value == "-"
				wantEnd := len(path)
				if consumes {
					wantEnd++
				}
				if end != wantEnd || (consumes && got != value) {
					t.Errorf("%q %s %q => %s %q end=%d want=%d", path, flag, value, name, got, end, wantEnd)
				}
				inlineFlag := flag + "=" + value
				if flag == short {
					inlineFlag = flag + value
				}
				inlineArgs := append(append([]string{}, path...), inlineFlag, "tail")
				_, inlineValue, inlineEnd := Option("grok", inlineArgs, len(path))
				if inlineValue != value || inlineEnd != len(path) {
					t.Errorf("%q inline %s => %q end=%d", path, inlineFlag, inlineValue, inlineEnd)
				}
				if flag == long && name != long {
					t.Errorf("%q %s canonical name %s", path, flag, name)
				}
				if consumes && value != long && (value == "--help" || value == "--version" || value == "--resume") && Has("grok", args, value) {
					t.Errorf("%q %s value %s became a flag", path, flag, value)
				}
			}
		}
	}
}

func TestGrok170CompleteValueOptionCorpus(t *testing.T) {
	for _, command := range grokCorpus(t).Commands {
		assertGrokHelpValues(t, command.Path, command.Help)
	}
}

func TestGrokContextualAliasesAndArity(t *testing.T) {
	for _, tc := range []struct {
		args        []string
		at          int
		name, value string
		end         int
	}{
		{[]string{"-s", "root-id", "mcp", "add", "-s", "project", "name"}, 0, "--session-id", "root-id", 1},
		{[]string{"-s", "root-id", "mcp", "add", "-s", "project", "name"}, 4, "--scope", "project", 5},
		{[]string{"mcp", "--debug-file", "add", "remove", "-sproject", "name"}, 4, "--scope", "project", 4},
		{[]string{"hello", "mcp", "add", "-tsse", "name"}, 3, "--transport", "sse", 3},
		{[]string{"worker", "controller", "--pool", "--help"}, 2, "--pool", "--help", 3},
		{[]string{"leader", "worker", "controller", "--pool", "--help"}, 3, "--pool", "--help", 4},
		{[]string{"worker", "start", "--pool", "--help"}, 2, "--pool", "", 2},
		{[]string{"update", "--version", "--help"}, 1, "--version", "--help", 2},
		{[]string{"export", "-c", "id"}, 1, "--clipboard", "", 1},
		{[]string{"sessions", "list", "-n", "--help"}, 2, "--limit", "--help", 3},
	} {
		name, value, end := Option("grok", tc.args, tc.at)
		if name != tc.name || value != tc.value || end != tc.end {
			t.Errorf("%q => %s %q %d", tc.args, name, value, end)
		}
	}
	if Resumed("grok", []string{"export", "-c", "id"}) {
		t.Fatal("clipboard alias became a continued session")
	}
	if Value("grok", []string{"mcp", "add", "-s", "project", "name"}, "--session-id") != "" {
		t.Fatal("MCP scope became session identity")
	}
	if !Has("grok", []string{"mcp", "remove", "-sproject", "name"}, "--scope") {
		t.Fatal("attached scope alias lost")
	}
	if Has("grok", []string{"mcp", "add", "--header", "--resume", "name"}, "--resume") {
		t.Fatal("header became session recovery")
	}
}

func TestCodexDaemonUtilitiesRequireManagedAdapter(t *testing.T) {
	for _, command := range []string{"queue", "archive", "unarchive", "delete"} {
		if got := UnsupportedService("codex", []string{command}); got != command {
			t.Errorf("%s => %q", command, got)
		}
		for _, args := range [][]string{{"--model", command}, {"--image", command, "more.png"}, {"exec", "--", command}, {"--", command}} {
			if got := UnsupportedService("codex", args); got != "" {
				t.Errorf("opaque %q became %s", args, got)
			}
		}
	}
	for _, value := range []string{"--resume", "agents", "--remote", "--help"} {
		args := []string{"queue", "--thread", "id", "--message", value}
		if got := Value("codex", args, "--message"); got != value {
			t.Fatal("queue message changed")
		}
		if Has("codex", args, value) {
			t.Errorf("queue message %s became a flag", value)
		}
	}
}

// Opt-in compares every value-taking option of the current native subcommand
// help against the wrapper corpus without running any native service or login.
func TestGrokValueOptionHelpOracle(t *testing.T) {
	binary := os.Getenv("NATIVE_GROK_ORACLE")
	if binary == "" {
		t.Skip("native help oracle not configured")
	}
	for _, command := range grokCorpus(t).Commands {
		home := t.TempDir()
		run := exec.Command(binary, append(append([]string{}, command.Path...), "--help")...)
		run.Env = []string{"HOME=" + home, "GROK_HOME=" + home, "GROK_DISABLE_AUTOUPDATER=1", "PATH=" + os.Getenv("PATH")}
		out, err := run.Output()
		if err != nil {
			t.Fatalf("%q help: %v", command.Path, err)
		}
		assertGrokHelpValues(t, command.Path, string(out))
	}
}

func TestCodexDaemonUtilityHelpOracle(t *testing.T) {
	binary := os.Getenv("NATIVE_CODEX_ORACLE")
	if binary == "" {
		t.Skip("native help oracle not configured")
	}
	for _, args := range [][]string{{"help", "queue"}, {"queue", "--resume", "--help"}, {"archive", "--help"}, {"help", "unarchive"}, {"delete", "--help"}} {
		home := t.TempDir()
		run := exec.Command(binary, args...)
		run.Env = []string{"HOME=" + home, "CODEX_HOME=" + home, "PATH=" + os.Getenv("PATH")}
		out, err := run.Output()
		if err != nil || !strings.Contains(string(out), "Usage: codex") {
			t.Fatalf("%q help: %v %s", args, err, out)
		}
	}
}
