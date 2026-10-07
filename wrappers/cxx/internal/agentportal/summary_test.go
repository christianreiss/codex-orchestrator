package agentportal

import (
	"io"
	"strings"
	"testing"
)

func TestCompactSummary(t *testing.T) {
	for input, want := range map[string]string{
		"": "", "  DNS fixed.\nRestart needed. ": "DNS fixed. Restart needed.",
		strings.Repeat("😀", 160): strings.Repeat("😀", 160),
		strings.Repeat("😀", 161): strings.Repeat("😀", 159) + "…",
	} {
		if got := CompactSummary(input); got != want {
			t.Errorf("summary = %q, want %q", got, want)
		}
	}
}

func TestSayAndAskSummariesAcrossEngines(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		for _, command := range []string{"say", "ask"} {
			t.Run(engine+"/"+command, func(t *testing.T) {
				stub := &portalStub{}
				withPortalEnv(t, startPortalStub(t, stub))
				t.Setenv(envEngine, engine)
				flag := "--text"
				if command == "ask" {
					flag = "--question"
				}
				if code := RunCommand([]string{command, flag, "Full text", "--summary", " Short result. "}, io.Discard, io.Discard); code != 0 {
					t.Fatalf("exit %d", code)
				}
				calls := stub.callsTo("/host/agent-sessions/" + stubSessionID + "/events")
				if len(calls) != 1 {
					t.Fatalf("event calls: %v", calls)
				}
				payload := calls[0].Body["payload"].(map[string]any)
				if payload["summary"] != "Short result." {
					t.Fatalf("payload: %v", payload)
				}
			})
		}
	}
}
