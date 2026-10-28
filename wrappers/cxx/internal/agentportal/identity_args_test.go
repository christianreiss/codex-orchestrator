package agentportal

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/pelletier/go-toml"
)

func TestIdentityPreservesDeveloperAndAppendInstructions(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("developer_instructions = 'Keep base rules'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	identity := Identity{Name: "Bärbel", Address: "agent:uuid", SessionID: "launch", Engine: "codex"}
	for _, args := range [][]string{{"exec", "--", "Task"}, {"exec", "resume", "native", "-c", `developer_instructions="Keep caller rules"`}, {"exec", "--config=developer_instructions='Keep inline rules'", "--", "--config=developer_instructions='literal prompt'"}} {
		got, err := AppendIdentityArgs("codex", args, identity)
		if err != nil {
			t.Fatal(err)
		}
		var override string
		for at, arg := range got {
			if arg == "-c" && at+1 < len(got) {
				override = got[at+1]
				break
			}
		}
		tree, err := toml.Load(override)
		if err != nil {
			t.Fatal(err)
		}
		text := tree.Get("developer_instructions").(string)
		if !strings.Contains(text, "Bärbel") || !strings.Contains(text, "Keep ") {
			t.Fatalf("rules lost: %q", text)
		}
		if args[len(args)-1] == "--config=developer_instructions='literal prompt'" && got[len(got)-1] != args[len(args)-1] {
			t.Fatal("literal prompt altered")
		}
	}
	for _, args := range [][]string{{"--profile", "exec", "exec", "-cdeveloper_instructions='Keep compact rules'"}, {"exec", "-c", "developer_instructions = 'Keep spaced rules'"}} {
		got, err := AppendIdentityArgs("codex", args, identity)
		if err != nil {
			t.Fatal(err)
		}
		text := strings.Join(got, " ")
		if !strings.Contains(text, "Bärbel") || (!strings.Contains(text, "Keep compact rules") && !strings.Contains(text, "Keep spaced rules")) {
			t.Fatalf("compact/spaced override lost: %v", got)
		}
		if args[0] == "--profile" && got[3] != "-c" {
			t.Fatal("override inserted before the native subcommand")
		}
	}
	for _, engine := range []string{"claude", "grok"} {
		flag := "--append-system-prompt"
		if engine == "grok" {
			flag = "--rules"
		}
		args := []string{flag, "Keep first rules", flag + "=Keep second rules", "--", "Do task"}
		if engine == "claude" {
			args = append([]string{"-p", "--system-prompt-snapshot=on", "--name", "(Claudia) Review"}, args...)
			identity.PreviousNames = []string{"Claudia"}
		}
		got, err := AppendIdentityArgs(engine, args, identity)
		if err != nil {
			t.Fatal(err)
		}
		if got[0] != flag || !strings.Contains(got[1], "Keep first rules\n\nKeep second rules") || !strings.Contains(got[1], "Bärbel") {
			t.Fatalf("append rules lost: %v", got)
		}
		if engine == "claude" && (!strings.Contains(strings.Join(got, " "), "--system-prompt-snapshot off") || !strings.Contains(strings.Join(got, " "), "--name (Bärbel) Review")) {
			t.Fatalf("resume identity/title not refreshed: %v", got)
		}
	}
}

func TestIdentityPreservesSelectedProfileAndDoesNotWriteSharedFiles(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	if err := os.WriteFile(filepath.Join(home, "review.config.toml"), []byte("developer_instructions = 'Keep profile rules'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Tanja", "Jessica"} {
		args, err := AppendIdentityArgs("codex", []string{"exec", "--cd", project, "--profile", "review", "--", "Task"}, Identity{Name: name})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(args[2], "Keep profile rules") || !strings.Contains(args[2], name) {
			t.Fatal("profile or per-launch context lost")
		}
	}
	raw, err := os.ReadFile(filepath.Join(home, "review.config.toml"))
	if err != nil || strings.Contains(string(raw), "Tanja") || strings.Contains(string(raw), "Jessica") {
		t.Fatal("identity leaked into shared profile")
	}
}

func TestClaudeIdentityPreservesCurrentOptionValues(t *testing.T) {
	for _, flag := range []string{"--append-subagent-system-prompt", "--append-subagent-system-prompt-file", "--advisor", "--system-prompt-file"} {
		args := []string{flag, "--append-system-prompt", "--system-prompt", "--resume", "--model", "opus"}
		got, err := AppendIdentityArgs("claude", args, Identity{Name: "Heide"})
		if err != nil {
			t.Fatal(err)
		}
		if len(got) < len(args) || !reflect.DeepEqual(got[len(got)-len(args):], args) {
			t.Fatalf("literal value changed: %v", got)
		}
		if hasClaudeResume(args) {
			t.Fatal("literal resume value suppressed launch title")
		}
	}
}

func TestClaudeIdentityCombinesAppendPromptFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prompt.txt")
	if err := os.WriteFile(path, []byte("Keep file instructions"), 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"--append-system-prompt-file", path, "-p", "Task"}
	got, err := AppendIdentityArgs("claude", args, Identity{Name: "Heide"})
	if err != nil {
		t.Fatal(err)
	}
	if got[0] != "--append-system-prompt" || !strings.Contains(got[1], "Keep file instructions") || !strings.Contains(got[1], "Heide") {
		t.Fatalf("file/context lost: %v", got)
	}
	for _, arg := range got {
		if arg == "--append-system-prompt-file" {
			t.Fatal("conflicting file flag retained")
		}
	}
	if _, err := AppendIdentityArgs("claude", append(args, "--append-system-prompt", "other"), Identity{Name: "Heide"}); err == nil {
		t.Fatal("invalid original flag combination accepted")
	}
	if _, err := AppendIdentityArgs("claude", []string{"--append-system-prompt-file", path + ".missing"}, Identity{Name: "Heide"}); err == nil {
		t.Fatal("missing prompt file ignored")
	}
}

func TestCodexExecAliasKeepsIdentityAfterResumeVerb(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	got, err := AppendIdentityArgs("codex", []string{"e", "resume", "native-id"}, Identity{Name: "Heide"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) < 4 || got[0] != "e" || got[1] != "resume" || got[2] != "-c" {
		t.Fatalf("identity override inserted at wrong alias position: %v", got)
	}
}

func TestNativeIdentityKeepsOptionBodiesOpaque(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	for _, args := range [][]string{{"--image", "first.png", "exec", "resume", "login"}, {"--image", "first.png", "resume", "-c", "model='fixture'"}, {"--image=first.png", "exec", "--", "Task"}} {
		got, err := AppendIdentityArgs("codex", args, Identity{Name: "Ava"})
		if err != nil {
			t.Fatal(err)
		}
		clean, values, err := removeStringFlag("codex", got, []string{"-c", "--config"}, "developer_instructions=")
		if err != nil || len(values) != 1 || !reflect.DeepEqual(clean, args) {
			t.Fatalf("%q => %q: %q %v", args, got, values, err)
		}
	}
	for _, flag := range []string{"-p", "--single", "--print", "--prompt-json", "--system-prompt-override", "--agents", "--allow", "--deny", "--tools", "--json-schema", "--debug-file", "--sandbox", "--ref"} {
		args := []string{flag, "--rules", "--rules=Keep caller rules"}
		got, err := AppendIdentityArgs("grok", args, Identity{Name: "Ava"})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(got[1], "Keep caller rules") || !reflect.DeepEqual(got[2:], args[:2]) {
			t.Fatalf("%s consumed a value: %q", flag, got)
		}
	}
	got, err := AppendIdentityArgs("grok", []string{"--append-system-prompt", "Keep aliased rules", "--worktree=--rules", "--single=--rules"}, Identity{Name: "Ava"})
	if err != nil || !strings.Contains(got[1], "Keep aliased rules") || got[2] != "--worktree=--rules" || got[3] != "--single=--rules" {
		t.Fatalf("rules alias: %q %v", got, err)
	}
}

func TestNativeResumeIdentityUsesOptionBoundaries(t *testing.T) {
	id := "01234567-89ab-4cde-8fab-0123456789ab"
	for _, tc := range []struct {
		engine string
		args   []string
		want   string
	}{
		{"codex", []string{"--model", "resume", "resume", "-c", "model='x'", id}, id},
		{"codex", []string{"--image", "resume", id}, ""},
		{"codex", []string{"e", "resume", "--", id}, id},
		{"codex", []string{"exec", "--model", "foo", "resume", id}, id},
		// Codex 0.165.0: nested exec resume takes one image; TUI resume keeps a list.
		{"codex", []string{"exec", "resume", "-i", "a.png", id, "continue"}, id},
		{"codex", []string{"e", "resume", "--image", "a.png", id}, id},
		{"codex", []string{"exec", "resume", id, "-i", "a.png"}, id},
		{"codex", []string{"resume", "-i", "a.png", id}, ""},
		{"codex", []string{"exec", "-i", "a.png", "resume", id}, ""},
		{"grok", []string{"--debug", "--resume=" + id}, id},
		{"grok", []string{"--print", "--resume=" + id}, ""},
		{"grok", []string{"--load", id}, id},
		{"grok", []string{"--resume", id, "--fork-session"}, ""},
		{"grok", []string{"--", "--resume", id}, ""},
	} {
		if got := NativeResumeSessionID(tc.engine, tc.args); got != tc.want {
			t.Errorf("%s %q => %q want %q", tc.engine, tc.args, got, tc.want)
		}
	}
}

func TestCodexIdentityFollowsNestedResumeOptions(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	got, err := AppendIdentityArgs("codex", []string{"exec", "--model", "foo", "resume", "native-id"}, Identity{Name: "Ava"})
	if err != nil || len(got) < 6 || got[3] != "resume" || got[4] != "-c" {
		t.Fatalf("nested identity misplaced: %q %v", got, err)
	}
}
