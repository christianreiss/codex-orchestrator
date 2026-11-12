package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// This canary needs only a native binary and a loopback synthetic provider,
// never a subscription credential or a fleet endpoint.
func TestKimiNativeHooksCanary(t *testing.T) {
	binary := os.Getenv("CXX_KIMI_CANARY_BIN")
	if binary == "" {
		t.Skip("set CXX_KIMI_CANARY_BIN to test the real Kimi CLI with a local mock provider")
	}
	root := t.TempDir()
	home := filepath.Join(root, "kimi")
	if err := os.Mkdir(home, 0700); err != nil {
		t.Fatal(err)
	}
	record := filepath.Join(root, "hooks.jsonl")
	hook := filepath.Join(root, "record-hook")
	script := `#!/bin/sh
payload=$(cat)
printf '%s\n' "$payload" >> ` + rebootShellQuote(record) + `
case "$payload" in
 *'"hook_event_name":"UserPromptSubmit"'*) printf '%s\n' 'KIMI_PROMPT_RING_CANARY' ;;
 *'"hook_event_name":"Stop"'*)
  if [ ! -f ` + rebootShellQuote(record+".stop") + ` ]; then
   touch ` + rebootShellQuote(record+".stop") + `
   printf '%s\n' 'KIMI_STOP_CONTINUE_CANARY' >&2
   exit 2
  fi ;;
esac
`

	if err := os.WriteFile(hook, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	var promptSeen, stopSeen atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			t.Errorf("unexpected provider route %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if bytes.Contains(body, []byte("KIMI_PROMPT_RING_CANARY")) {
			promptSeen.Store(true)
		}
		if bytes.Contains(body, []byte("KIMI_STOP_CONTINUE_CANARY")) {
			stopSeen.Store(true)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Probe complete.\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	config := fmt.Sprintf("default_model = \"probe\"\ntelemetry = false\n[providers.probe]\ntype = \"openai\"\napi_key = \"synthetic-probe\"\nbase_url = %q\n[models.probe]\nprovider = \"probe\"\nmodel = \"probe\"\nmax_context_size = 32768\n", server.URL+"/v1")
	for _, event := range []string{"SessionStart", "UserPromptSubmit", "Stop"} {
		config += fmt.Sprintf("\n[[hooks]]\nevent = %q\ncommand = %q\ntimeout = 30\n", event, "'"+strings.ReplaceAll(hook, "'", "'\\''")+"'")
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "-p", "probe", "--output-format", "stream-json")
	cmd.Dir = root
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + root, "KIMI_CODE_HOME=" + home, "KIMI_DISABLE_TELEMETRY=1", "KIMI_CODE_NO_AUTO_UPDATE=1", "KIMI_CODE_TRUST_WORKSPACE=1"}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("native probe: %v: %s", err, stderr.String())
	}
	if !promptSeen.Load() || !stopSeen.Load() {
		t.Fatalf("native hook context missing: prompt=%v stop=%v stdout=%s stderr=%s", promptSeen.Load(), stopSeen.Load(), raw, stderr.String())
	}
	reply, id := parseKimiOutput(raw)
	if reply != "Probe complete." || !kimiSessionID(id) {
		t.Fatalf("real stream schema: %s", raw)
	}
	t.Setenv("KIMI_CODE_HOME", home)
	if err := checkKimiTranscript(id); err != nil {
		t.Fatal(err)
	}
	hooks, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, line := range bytes.Split(hooks, []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var h struct {
			Event  string          `json:"hook_event_name"`
			ID     string          `json:"session_id"`
			Cwd    string          `json:"cwd"`
			Client string          `json:"client_type"`
			Prompt json.RawMessage `json:"prompt"`
		}
		if err := json.Unmarshal(line, &h); err != nil {
			t.Fatal(err)
		}
		if h.ID != id || h.Cwd != root || h.Client != "kimi_code_cli" {
			t.Fatalf("unexpected hook identity %s", line)
		}
		if h.Event == "UserPromptSubmit" && !bytes.Contains(h.Prompt, []byte(`"text":"probe"`)) {
			t.Fatalf("unexpected prompt shape: %s", h.Prompt)
		}
		seen[h.Event] = true
	}
	for _, event := range []string{"SessionStart", "UserPromptSubmit", "Stop"} {
		if !seen[event] {
			t.Fatal("missing native hook", event)
		}
	}
}
