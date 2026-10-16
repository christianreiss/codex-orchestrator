package agentbus

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/contentnotice"
)

func publishTestContentNotice(t *testing.T, engine string) {
	t.Helper()
	sum := sha256.Sum256([]byte("pushed fleet content"))
	notice := contentnotice.Notice{Generation: hex.EncodeToString(sum[:]), Engine: engine, Kinds: []string{contentnotice.KindInstructions}}
	if err := contentnotice.Publish(notice); err != nil {
		t.Fatal(err)
	}
}

func TestContentNoticeRidesMCPResultBesideAuthNoticeOnce(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", "")
	t.Setenv("GROK_HOME", "")
	for _, engine := range []string{"codex", "claude", "grok"} {
		publishTestContentNotice(t, engine)
		if engine != "grok" {
			publishTestNotice(t, engine)
		}
		result := map[string]any{"content": []map[string]any{{"type": "text", "text": "original"}}}
		response := mcpSuccess(json.RawMessage("3"), result)
		if err := prepareSessionNotices(response, engine, "agent").Commit(); err != nil {
			t.Fatal(err)
		}
		content := result["content"].([]map[string]any)
		joined := ""
		for _, part := range content[1:] {
			joined += part["text"].(string)
		}
		if content[0]["text"] != "original" || !strings.Contains(joined, "fleet instructions") {
			t.Fatalf("%s: unexpected content: %+v", engine, content)
		}
		if engine != "grok" && !strings.Contains(joined, "credentials were updated") {
			t.Fatalf("%s: auth notice lost: %+v", engine, content)
		}
		before := len(content)
		prepareSessionNotices(response, engine, "agent").Commit()
		if len(result["content"].([]map[string]any)) != before {
			t.Fatalf("%s: notice repeated", engine)
		}
	}
}

func TestContentNoticeReachesClaudePromptOnceAndNeverBlocksStop(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "content-claude")
	publishTestContentNotice(t, "claude")
	var out bytes.Buffer
	if err := emitHook(&out, hookEventStop, &mailbox{}, nil); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatalf("content notice blocked Stop: %s", out.String())
	}
	if err := emitHook(&out, hookEventPrompt, &mailbox{}, nil); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	hook := payload["hookSpecificOutput"].(map[string]any)
	if !strings.Contains(hook["additionalContext"].(string), "CLAUDE.md") {
		t.Fatalf("missing context: %+v", payload)
	}
	out.Reset()
	if err := emitHook(&out, hookEventPrompt, &mailbox{}, nil); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatal("content notice repeated on later prompt")
	}
}
