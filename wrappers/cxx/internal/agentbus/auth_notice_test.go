package agentbus

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/authnotice"
)

func publishTestNotice(t *testing.T, engine string) {
	t.Helper()
	sum := sha256.Sum256([]byte("verified adopted credential"))
	if err := authnotice.Publish(engine, hex.EncodeToString(sum[:])); err != nil {
		t.Fatal(err)
	}
}

type failingAuthNoticeWriter struct{}

func (failingAuthNoticeWriter) Write([]byte) (int, error) { return 0, errors.New("closed output") }

func TestFailedHookOutputLeavesAuthNoticePending(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "retry-session")
	publishTestNotice(t, "claude")
	if err := emitHook(failingAuthNoticeWriter{}, hookEventPrompt, &mailbox{}); err == nil {
		t.Fatal("expected output failure")
	}
	var retry bytes.Buffer
	if err := emitHook(&retry, hookEventPrompt, &mailbox{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(retry.String(), "credentials were updated") {
		t.Fatal("failed output permanently consumed notice")
	}
}

func TestAuthNoticePreservesMCPResultAndSignalsEverySession(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", "")
	for _, engine := range []string{"codex", "claude"} {
		publishTestNotice(t, engine)
		for _, session := range []string{"first-agent", "second-agent"} {
			structured := map[string]any{"ok": true}
			result := map[string]any{"content": []map[string]any{{"type": "text", "text": "original"}}, "structuredContent": structured}
			response := mcpSuccess(json.RawMessage("7"), result)
			prepareAuthNotice(response, engine, session).Commit()
			content := result["content"].([]map[string]any)
			if len(content) != 2 || content[0]["text"] != "original" || !strings.Contains(content[1]["text"].(string), "credentials were updated") {
				t.Fatalf("unexpected content: %+v", content)
			}
			if result["structuredContent"].(map[string]any)["ok"] != true {
				t.Fatal("tool result changed")
			}
			prepareAuthNotice(response, engine, session).Commit()
			if len(result["content"].([]map[string]any)) != 2 {
				t.Fatal("notice repeated")
			}
		}
	}
}

func TestAuthOnlyNoticeNeverBlocksStopAndReachesPromptOnce(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "active-claude")
	publishTestNotice(t, "claude")
	var out bytes.Buffer
	if err := emitHook(&out, hookEventStop, &mailbox{}); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatalf("auth adoption blocked Stop: %s", out.String())
	}
	if err := emitHook(&out, hookEventPrompt, &mailbox{}); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if _, exists := payload["decision"]; exists {
		t.Fatal("auth notice changed native turn control")
	}
	hook := payload["hookSpecificOutput"].(map[string]any)
	if hook["hookEventName"] != hookEventPrompt || !strings.Contains(hook["additionalContext"].(string), "Claude credentials") {
		t.Fatalf("missing context: %+v", payload)
	}
	out.Reset()
	if err := emitHook(&out, hookEventPrompt, &mailbox{}); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatal("auth notice repeated on later prompt")
	}
}

func TestAuthNoticeSharesDeliveryLedgerAcrossHookAndMCP(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "same-session")
	publishTestNotice(t, "claude")
	result := map[string]any{"content": []map[string]any{{"type": "text", "text": "done"}}}
	prepareAuthNotice(mcpSuccess(json.RawMessage("1"), result), "claude", "same-session").Commit()
	var out bytes.Buffer
	if err := emitHook(&out, hookEventPrompt, &mailbox{}); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatal("MCP notice repeated through prompt hook")
	}
}
