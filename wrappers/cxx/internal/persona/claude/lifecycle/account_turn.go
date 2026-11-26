package lifecycle

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Scope-wide turn heuristic for live account switches.
//
// Every Claude process of a scope reacts to a rewritten credentials file, not
// only this launch's child, and a non-receiver launch has no hook evidence at
// all. So in addition to the broker's hook state, a switch requires that every
// transcript under <scope>/projects touched within transcriptActiveWindow
// has been quiet for transcriptSettle and ends with a completed assistant
// reply (stop_reason end_turn/stop_sequence). A trailing user prompt or tool
// result, or an assistant tool_use, means a turn or a tool is still running.
// Transcripts untouched for longer than the window are treated as idle
// sessions; a tool that runs silently longer than that window is the known
// limit of this heuristic. Subagent transcripts (nested directories) are not
// root turns and are ignored.
const (
	transcriptActiveWindow = 15 * time.Minute
	transcriptSettle       = 20 * time.Second
	transcriptTailBytes    = 256 << 10
)

func scopeTranscriptsQuiet(projectsDir string, now time.Time) bool {
	paths, err := filepath.Glob(filepath.Join(projectsDir, "*", "*.jsonl"))
	if err != nil {
		return false
	}
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		age := now.Sub(info.ModTime())
		if age > transcriptActiveWindow {
			continue
		}
		if age < transcriptSettle || !transcriptTurnEnded(path) {
			return false
		}
	}
	return true
}

type transcriptEntry struct {
	Type    string          `json:"type"`
	IsMeta  bool            `json:"isMeta"`
	Message json.RawMessage `json:"message"`
}

type transcriptMessage struct {
	Role       string          `json:"role"`
	StopReason *string         `json:"stop_reason"`
	Content    json.RawMessage `json:"content"`
}

// transcriptTurnEnded inspects the last conversation entry. Metadata lines
// (system, summaries, cost state, ...) and meta/local-command user entries
// are skipped. An unreadable tail is treated as a running turn.
func transcriptTurnEnded(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return false
	}
	offset := info.Size() - transcriptTailBytes
	if offset < 0 {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return false
	}
	tail, err := io.ReadAll(io.LimitReader(f, transcriptTailBytes))
	if err != nil {
		return false
	}
	lines := bytes.Split(tail, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 {
			continue
		}
		var entry transcriptEntry
		if json.Unmarshal(line, &entry) != nil {
			if i == 0 && offset > 0 {
				break // truncated first line of the tail window
			}
			return false
		}
		switch entry.Type {
		case "assistant":
			var m transcriptMessage
			if json.Unmarshal(entry.Message, &m) != nil || m.StopReason == nil {
				return false
			}
			return *m.StopReason == "end_turn" || *m.StopReason == "stop_sequence"
		case "user":
			if entry.IsMeta || localCommandEntry(entry.Message) {
				continue
			}
			return false
		}
	}
	return true
}

// localCommandEntry recognizes slash-command bookkeeping that Claude records
// as user entries without starting a model turn.
func localCommandEntry(raw json.RawMessage) bool {
	var m transcriptMessage
	if json.Unmarshal(raw, &m) != nil {
		return false
	}
	var text string
	if json.Unmarshal(m.Content, &text) != nil {
		return false
	}
	text = strings.TrimSpace(text)
	for _, prefix := range []string{"<command-name>", "<local-command-stdout>", "<local-command-stderr>", "<command-message>", "<local-command-caveat>"} {
		if strings.HasPrefix(text, prefix) {
			return true
		}
	}
	return false
}
