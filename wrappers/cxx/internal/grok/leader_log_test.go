package grok

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestLeaderDiagnosticsDoNotReachTerminal(t *testing.T) {
	dir := t.TempDir()
	log, err := OpenLeaderLog(dir)
	if err != nil {
		t.Fatal(err)
	}
	other, err := OpenLeaderLog(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if other.Path() == log.Path() {
		t.Fatal("concurrent leaders share a log")
	}
	var terminal bytes.Buffer
	cmd := exec.Command("sh", "-c", `printf 'native tool result\n'; printf 'ERROR tool_error: tool_output_error tool_name="read_file"\n' >&2`)
	cmd.Stdout, cmd.Stderr = &terminal, log
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	if terminal.String() != "native tool result\n" {
		t.Fatalf("background diagnostics leaked: %q", terminal.String())
	}
	raw, err := os.ReadFile(log.Path())
	if err != nil || !strings.Contains(string(raw), `tool_name="read_file"`) {
		t.Fatalf("raw diagnostic lost: %q %v", raw, err)
	}
	st, err := os.Stat(log.Path())
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatal("diagnostics must be private")
	}
}

func TestLeaderDiagnosticsStayBoundedAndKeepRecentOutput(t *testing.T) {
	log, err := OpenLeaderLog(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	for _, body := range [][]byte{bytes.Repeat([]byte("a"), leaderLogLimit), []byte("new error"), bytes.Repeat([]byte("z"), leaderLogLimit+100)} {
		if n, err := log.Write(body); err != nil || n != len(body) {
			t.Fatalf("write=%d %v", n, err)
		}
		raw, err := os.ReadFile(log.Path())
		if err != nil || len(raw) > leaderLogLimit || !bytes.HasSuffix(raw, body[len(body)-9:]) {
			t.Fatal("log grew beyond its bound or lost the newest output")
		}
	}
}

func TestLeaderDiagnosticsOpenFailureIsVisible(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/leader-logs", []byte("occupied"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenLeaderLog(dir); err == nil {
		t.Fatal("unavailable log destination ignored")
	}
}
