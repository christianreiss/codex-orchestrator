package agentbus

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestGrokResumeChecksDurableTranscriptBeforeStarting(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	root := t.TempDir()
	t.Setenv("GROK_HOME", root)
	old := startNativeCommand
	defer func() { startNativeCommand = old }()
	started := false
	startNativeCommand = func(*exec.Cmd) error { started = true; return errors.New("fixture start failure") }
	client := &relayClient{http: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}}
	delivery := &relayDelivery{Target: map[string]any{"engine": "grok", "cwd": root}}
	result := client.runNative(context.Background(), &config.Config{}, delivery, id, true)
	if started || result.Started || !result.MissingTranscript || !errors.Is(result.Err, errNativeTranscriptMissing) {
		t.Fatalf("absent transcript was not blocked: %+v started=%v", result, started)
	}
	path := filepath.Join(root, "sessions", "project", id, "summary.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"id":"`+id+`"}`), 0600); err != nil {
		t.Fatal(err)
	}
	result = client.runNative(context.Background(), &config.Config{}, delivery, id, true)
	if !started || result.MissingTranscript {
		t.Fatalf("existing transcript misclassified: %+v started=%v", result, started)
	}
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := checkGrokTranscript(id); err == nil || errors.Is(err, errNativeTranscriptMissing) {
		t.Fatalf("corrupt transcript must not authorize fresh start: %v", err)
	}
	if isMissingTranscript(`{"type":"error","message":"Couldn't start session: authentication failed"}`) {
		t.Fatal("generic start failure grants replacement")
	}
}
