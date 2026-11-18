package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type codexSessionModel struct {
	ID              string `json:"id"`
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
	Source          string `json:"source"`
	TurnID          string `json:"turn_id,omitempty"`
}

// Use a separate passive connection to the launch-private app-server. The
// server's authenticated binding supplies the thread ID, never an MCP argument,
// a launch model, or the most recently modified transcript.
func observeCodexSessionModel(ctx context.Context, socket, nativeID string) *codexSessionModel {
	if socket == "" || nativeID == "" {
		return nil
	}
	queue, err := openNativeQueueUntil(ctx, socket, time.Now().Add(2*time.Second))
	if err != nil {
		return nil
	}
	defer queue.close()
	queue.thread = nativeID
	var read struct {
		Thread struct {
			ID              string `json:"id"`
			Path            string `json:"path"`
			Model           string `json:"model"`
			ReasoningEffort string `json:"reasoningEffort"`
			Status          struct {
				Type string `json:"type"`
			} `json:"status"`
		} `json:"thread"`
	}
	err = queue.call("thread/read", map[string]any{"threadId": nativeID, "includeTurns": false}, &read)
	thread := read.Thread
	if err != nil || thread.ID != nativeID {
		return nil
	}
	switch thread.Status.Type {
	case "active":
		if turn, err := queue.latestTurnPage(); err == nil && turn != nil && turn.Status == "inProgress" && turn.ID != "" {
			if model := readCodexTurnModel(thread.Path, nativeID, turn.ID); model != nil {
				return model
			}
		}
	case "idle":
	default:
		// Unloaded threads can still return their most recently persisted model.
		return nil
	}
	if model := strings.TrimSpace(thread.Model); model != "" {
		return &codexSessionModel{ID: model, ReasoningEffort: thread.ReasoningEffort, Source: "codex_thread_settings"}
	}
	return nil
}

// Codex's per-turn model is in the rollout. Read only a bounded tail of the
// app-server's own rollout path and accept only the live turn returned above.
// The rollout can be appended concurrently, so ignore an incomplete last line.
func readCodexTurnModel(path, nativeID, turnID string) *codexSessionModel {
	const maxRolloutTail = 4 << 20
	if !filepath.IsAbs(path) || !strings.HasSuffix(filepath.Base(path), "-"+nativeID+".jsonl") {
		return nil
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	offset := max(0, info.Size()-maxRolloutTail)
	data, err := io.ReadAll(io.NewSectionReader(file, offset, info.Size()-offset))
	if err != nil {
		return nil
	}
	if offset != 0 {
		_, data, _ = bytes.Cut(data, []byte{'\n'})
	}
	end := bytes.LastIndexByte(data, '\n')
	for end >= 0 {
		start := bytes.LastIndexByte(data[:end], '\n') + 1
		line := data[start:end]
		end = start - 1
		if !bytes.Contains(line, []byte(`"turn_context"`)) {
			continue
		}
		var record struct {
			Type    string `json:"type"`
			Payload struct {
				TurnID string `json:"turn_id"`
				Model  string `json:"model"`
				Effort string `json:"effort"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &record) == nil && record.Type == "turn_context" && record.Payload.TurnID == turnID {
			if model := strings.TrimSpace(record.Payload.Model); model != "" {
				return &codexSessionModel{ID: model, ReasoningEffort: record.Payload.Effort, Source: "codex_turn_context", TurnID: turnID}
			}
			return nil
		}
	}
	return nil
}
