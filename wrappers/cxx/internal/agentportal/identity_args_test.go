package agentportal

import (
	"os"
	"path/filepath"
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
