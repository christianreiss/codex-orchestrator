package agentbus

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDaemonJournalSurvivesAmbiguousExecution(t *testing.T) {
	dir := t.TempDir()
	op := daemonOperation{ID: newUUID(), Claim: newUUID(), Session: newUUID(), Prompt: "task"}
	if err := saveDaemonJournal(dir, daemonJournal{Operation: op}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, op.ID+".json")
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal(info, err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var j daemonJournal
	if err := json.Unmarshal(body, &j); err != nil {
		t.Fatal(err)
	}
	if j.Result != nil || j.Operation.Claim != op.Claim {
		t.Fatal("pending acceptance must survive restart", j)
	}
	j.Result = &daemonResult{Status: "completed", Reply: "done"}
	if err := saveDaemonJournal(dir, j); err != nil {
		t.Fatal(err)
	}
	body, _ = os.ReadFile(path)
	if err := json.Unmarshal(body, &j); err != nil || j.Result.Reply != "done" {
		t.Fatal(j, err)
	}
}
func TestDaemonRejectsInvalidDirectoryBeforeSpawning(t *testing.T) {
	for _, cwd := range []string{"relative", filepath.Join(t.TempDir(), "missing")} {
		result := runDaemonOperation(context.Background(), daemonOperation{Cwd: cwd, Engine: "codex"})
		if result.Status != "failed" {
			t.Fatal(result)
		}
	}
}
func TestDaemonRejectsUnknownEngine(t *testing.T) {
	if result := runDaemonOperation(context.Background(), daemonOperation{Cwd: t.TempDir(), Engine: "shell"}); result.Status != "failed" {
		t.Fatal(result)
	}
}

func TestDaemonNativeAdaptersProduceResumableResults(t *testing.T) {
	original := daemonExecutable
	defer func() { daemonExecutable = original }()
	for engine, body := range map[string]string{
		"codex":  "{\"type\":\"thread.started\",\"thread_id\":\"native-1\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}",
		"claude": "{\"result\":\"hello\",\"session_id\":\"native-1\",\"subtype\":\"success\"}",
		"grok":   "{\"text\":\"hello\",\"sessionId\":\"native-1\",\"stopReason\":\"end_turn\"}",
	} {
		t.Run(engine, func(t *testing.T) {
			dir := t.TempDir()
			script := filepath.Join(dir, "native-fixture")
			// Fixed fixture strings contain no shell metacharacters or credentials.
			if err := os.WriteFile(script, []byte("#!/bin/sh\ncat <<'RESULT'\n"+body+"\nRESULT\n"), 0700); err != nil {
				t.Fatal(err)
			}
			daemonExecutable = func() (string, error) { return script, nil }
			result := runDaemonOperation(context.Background(), daemonOperation{ID: newUUID(), Claim: newUUID(), Cwd: dir, Engine: engine, Prompt: "hello", Title: "test"})
			if result.Status != "completed" || result.Reply != "hello" || result.Upstream != "native-1" {
				t.Fatal(result)
			}
		})
	}
}
