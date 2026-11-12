package agentportal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKimiResumeUsesNativeSessionPrefix(t *testing.T) {
	id := "session_11111111-1111-4111-8111-111111111111"
	for _, args := range [][]string{{"-S", id}, {"--session=" + id}, {"-m", "probe", "-r", id}, {"--resume", id}} {
		if got := NativeResumeSessionID("kimi", args); got != id {
			t.Fatal(args, got)
		}
	}
	for _, args := range [][]string{{"-p", "-S", id}, {"--", "-S", id}, {"-S", "../escape"}, {"-S", "11111111-1111-4111-8111-111111111111"}} {
		if got := NativeResumeSessionID("kimi", args); got != "" {
			t.Fatal(args, got)
		}
	}
}
func TestKimiPrivateIdentityOverlayPreservesAgentAndFleetContent(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "AGENTS.md")
	if err := os.WriteFile(path, []byte("Fleet instructions\n"), 0600); err != nil {
		t.Fatal(err)
	}
	identity := Identity{Name: "Waltraud", Engine: "kimi", SessionID: "launch"}
	args := []string{"-S", "session_11111111-1111-4111-8111-111111111111", "-m", "probe"}
	got, err := AppendKimiIdentityArgs(args, identity, home)
	if err != nil || strings.Join(got, " ") != strings.Join(args, " ") {
		t.Fatal(got, err)
	}
	identity.Name = "NewName"
	if _, err = AppendKimiIdentityArgs(args, identity, home); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	body := string(raw)
	if !strings.HasPrefix(body, "Fleet instructions\n") || !strings.Contains(body, "NewName") || strings.Contains(body, "Waltraud") || strings.Count(body, "cxx:launch-identity:start") != 1 {
		t.Fatal(body)
	}
	if strings.Contains(strings.Join(got, " "), "--agent-file") {
		t.Fatal("cannot resume a bound agent with --agent-file")
	}
}
func TestKimiWorkspaceUsesProcessDirectory(t *testing.T) {
	want, _ := os.Getwd()
	got, err := launchCwd("kimi", []string{"-p", "--cwd=/foreign"})
	if err != nil || got != want {
		t.Fatal(got, err)
	}
}

func TestKimiActivityUsesNativeLifecycle(t *testing.T) {
	for _, tc := range []struct{ event, state string }{{"UserPromptSubmit", "working"}, {"TurnStarted", "working"}, {"PermissionResult", "working"}, {"PermissionRequest", "waiting"}, {"Stop", "idle"}, {"Interrupt", "idle"}, {"SessionEnd", "idle"}, {"SessionStart", "unknown"}} {
		a := KimiActivity(ActivityHook{Event: tc.event})
		if a.State != tc.state || a.Source != "kimi-hooks" {
			t.Fatal(tc, a)
		}
	}
}

func TestKimiIdentityRequiresExplicitPerLaunchHome(t *testing.T) {
	t.Setenv("KIMI_CODE_HOME", t.TempDir())
	identity := Identity{Name: "Waltraud", Engine: "kimi", SessionID: "launch"}
	if _, err := AppendIdentityArgs("kimi", nil, identity); err == nil {
		t.Fatal("generic injection could overwrite a shared base home")
	}
	if _, err := AppendIdentityArgs("kimi", nil, identity, t.TempDir()); err != nil {
		t.Fatal(err)
	}
}
