package claude

import (
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

func TestBackgroundServiceLifetimeAndOpaqueValues(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"--bg", "prompt"}, "--bg"},
		{[]string{"--background", "--resume", "session"}, "--background"},
		{[]string{"prompt", "--bg"}, "--bg"},
		{[]string{"gateway", "--config", "file.yaml"}, "gateway"},
		{[]string{"respawn", "session"}, "respawn"},
		{[]string{"attach", "session"}, "attach"},
		{[]string{"agents"}, "agents"},
		{[]string{"agents", "--model", "--json"}, "agents"},
		{[]string{"agents", "--cwd", "--json"}, "agents"},
		{[]string{"agents", "--json", "--unknown"}, "agents"},
		{[]string{"agents", "--json", "--all", "--cwd", "gateway"}, ""},
		{[]string{"agents", "--cwd=--background", "--json"}, ""},
		{[]string{"--model", "gateway", "agents", "--json"}, ""},
		{[]string{"--system-prompt", "--background"}, ""},
		{[]string{"--system-prompt", "gateway"}, ""},
		{[]string{"--resume", "agents"}, ""},
		{[]string{"--add-dir", "one", "gateway", "agents"}, ""},
		{[]string{"--", "--bg"}, ""},
		{[]string{"--bg", "--help"}, "--bg"},
		{[]string{"gateway", "--help"}, ""},
		{[]string{"gateway", "--config", "--help"}, "gateway"},
		{[]string{"help", "gateway"}, ""},
	} {
		before := append([]string(nil), tc.args...)
		if got := UnsupportedNativeService(tc.args); got != tc.want {
			t.Errorf("%q: got %q want %q", tc.args, got, tc.want)
		}
		if !reflect.DeepEqual(before, tc.args) {
			t.Fatal("guard mutated argv")
		}
	}
}

func TestCurrentBackgroundServiceHelpOracle(t *testing.T) {
	binary := os.Getenv("NATIVE_CLAUDE_ORACLE")
	if binary == "" {
		t.Skip("native help oracle not configured")
	}
	for _, tc := range []struct {
		args []string
		text string
	}{
		{[]string{"--help"}, "return immediately"},
		{[]string{"gateway", "--help"}, "enterprise auth/telemetry gateway"},
		{[]string{"agents", "--json", "--help"}, "as a JSON array and exit"},
		{[]string{"respawn", "--help"}, "Restart a background session"},
		{[]string{"attach", "--help"}, "background session"},
	} {
		cmd := exec.Command(binary, tc.args...)
		home := t.TempDir()
		cmd.Env = []string{"HOME=" + home, "CLAUDE_CONFIG_DIR=" + home, "DISABLE_AUTOUPDATER=1", "DISABLE_UPDATES=1", "PATH=" + os.Getenv("PATH")}
		out, err := cmd.Output()
		if err != nil || !strings.Contains(string(out), tc.text) {
			t.Fatalf("%q: %v %s", tc.args, err, out)
		}
	}
}
