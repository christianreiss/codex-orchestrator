// Package codex — usage.go ports the legacy bash + python token extraction
// from bin/cdx.d/03-sync-50-usage.sh into typed Go. Three entry points:
//
//   - ParseStdoutCapture: scans buffered stdout for the upstream
//     "Token usage: total=… input=… output=…" footer line that the Codex
//     CLI prints in non-interactive mode.
//   - DiscoverSessions:   lists ~/.codex/sessions/**/*.jsonl files modified
//     after a given start time (interactive runs land here).
//   - ParseSessionJSONL:  sums every `token_count` and `turn.completed`
//     event in a JSONL session file.
//
// The legacy bash always ran a python helper to do this; porting to Go means
// we can call it from a single binary without depending on a system python3.
package codex

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Tokens holds the running totals extracted for one session/run.
type Tokens struct {
	Total     int64
	Input     int64
	Output    int64
	Cached    int64
	Reasoning int64
}

// Add accumulates `other` into the receiver. Returns the receiver for chaining.
func (t *Tokens) Add(other Tokens) {
	t.Total += other.Total
	t.Input += other.Input
	t.Output += other.Output
	t.Cached += other.Cached
	t.Reasoning += other.Reasoning
}

// IsZero reports whether all token counters are zero (i.e. nothing extracted).
func (t Tokens) IsZero() bool {
	return t.Total == 0 && t.Input == 0 && t.Output == 0 && t.Cached == 0 && t.Reasoning == 0
}

// ─── ANSI / control char stripping ────────────────────────────────────────────
//
// Port of the legacy python `strip_noise` helper. Order matches the python:
// OSC sequences first (they may contain CSI-looking bytes), then CSI, then
// loose control chars. We intentionally do NOT strip \n, \r, \t.

var (
	ansiCSI = regexp.MustCompile(`\x1B\[[0-9;?]*[ -/]*[@-~]`)
	ansiOSC = regexp.MustCompile(`\x1B\][^\a\x1B]*[\a\x1B\\]`)
	control = regexp.MustCompile(`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`)
)

func stripNoise(s string) string {
	s = ansiOSC.ReplaceAllString(s, "")
	s = ansiCSI.ReplaceAllString(s, "")
	s = control.ReplaceAllString(s, "")
	return s
}

// ─── Stdout capture parser ────────────────────────────────────────────────────

// tokenUsagePattern matches the upstream Codex CLI footer line. It accepts
// thousands separators (`,`), optional "(+N cached)" after input, and optional
// "(reasoning N)" after output. Case-insensitive via (?i).
var tokenUsagePattern = regexp.MustCompile(
	`(?i)Token usage:\s*total=([\d,]+)\s+input=([\d,]+)(?:\s*\(\+\s*([\d,]+)\s*cached\))?\s+output=([\d,]+)(?:\s*\(reasoning\s*([\d,]+)\))?`,
)

func parseCommaInt(s string) int64 {
	s = strings.ReplaceAll(s, ",", "")
	if s == "" {
		return 0
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

// ParseStdoutCapture scans `buf` for the most recent recognizable Codex
// "Token usage:…" line. Returns ok=false if no line matched.
//
// The scan is right-to-left: the upstream CLI may emit multiple usage lines
// (e.g. one per turn) and the last one is the authoritative cumulative total.
func ParseStdoutCapture(buf []byte) (Tokens, bool) {
	if len(buf) == 0 {
		return Tokens{}, false
	}
	cleaned := stripNoise(string(buf))
	lines := strings.Split(cleaned, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		if !strings.Contains(strings.ToLower(line), "token usage") {
			continue
		}
		m := tokenUsagePattern.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		tok := Tokens{
			Total:  parseCommaInt(m[1]),
			Input:  parseCommaInt(m[2]),
			Output: parseCommaInt(m[4]),
		}
		if m[3] != "" {
			tok.Cached = parseCommaInt(m[3])
		}
		if m[5] != "" {
			tok.Reasoning = parseCommaInt(m[5])
		}
		return tok, true
	}
	return Tokens{}, false
}

// ─── JSONL session file discovery + parsing ───────────────────────────────────

// DiscoverSessions walks `dir` recursively and returns the absolute paths of
// every *.jsonl file whose mtime is at or after `since`. Sort order is by
// modification time ascending so callers process oldest → newest.
//
// Returns (nil, nil) if `dir` does not exist; that's a normal first-run case.
func DiscoverSessions(dir string, since time.Time) ([]string, error) {
	info, err := os.Stat(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("session path %q is not a directory", dir)
	}

	type entry struct {
		path  string
		mtime time.Time
	}
	var found []entry
	walkErr := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// Tolerate permission errors on individual children; just skip.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
			return nil
		}
		st, err := d.Info()
		if err != nil {
			return nil
		}
		if st.ModTime().Before(since) {
			return nil
		}
		found = append(found, entry{path: path, mtime: st.ModTime()})
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}

	// Sort oldest → newest. Mtime tie → name tie-break for determinism.
	for i := 1; i < len(found); i++ {
		for j := i; j > 0; j-- {
			a, b := found[j-1], found[j]
			if a.mtime.After(b.mtime) || (a.mtime.Equal(b.mtime) && a.path > b.path) {
				found[j-1], found[j] = b, a
			} else {
				break
			}
		}
	}

	out := make([]string, len(found))
	for i, e := range found {
		out[i] = e.path
	}
	return out, nil
}

// ParseSessionJSONL reads a Codex session JSONL file line-by-line, summing
// token counts from `event_msg` events with payload type `token_count` and
// from `turn.completed` events. Tracks cumulative totals across the whole
// file with simple dedup against the immediately previous signature so we
// don't double-count repeated identical "tail" events.
//
// Unparseable lines are skipped silently — the file may be open and partially
// flushed when we read it.
func ParseSessionJSONL(path string) (Tokens, error) {
	f, err := os.Open(path)
	if err != nil {
		return Tokens{}, err
	}
	defer f.Close()

	var total Tokens
	var lastSig [5]int64
	var haveLast bool

	scanner := bufio.NewScanner(f)
	// Codex JSONL lines can be long (full tool call payloads). Bump the limit.
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		raw := scanner.Bytes()
		if len(raw) == 0 {
			continue
		}
		var ev map[string]any
		if err := json.Unmarshal(raw, &ev); err != nil {
			continue
		}
		entry, ok := extractJSONLEntry(ev)
		if !ok {
			continue
		}
		sig := [5]int64{entry.Total, entry.Input, entry.Output, entry.Cached, entry.Reasoning}
		if haveLast && sig == lastSig {
			continue
		}
		lastSig = sig
		haveLast = true
		total.Add(entry)
	}
	if err := scanner.Err(); err != nil {
		// Bail out with what we have — partial data is better than nothing.
		return total, err
	}
	return total, nil
}

func extractJSONLEntry(ev map[string]any) (Tokens, bool) {
	typ, _ := ev["type"].(string)
	switch typ {
	case "event_msg":
		payload, _ := ev["payload"].(map[string]any)
		if payload == nil {
			return Tokens{}, false
		}
		ptype, _ := payload["type"].(string)
		if ptype != "token_count" {
			return Tokens{}, false
		}
		info, _ := payload["info"].(map[string]any)
		if info == nil {
			return Tokens{}, false
		}
		// Prefer last_token_usage (per-turn delta), fall back to total_token_usage.
		usage, _ := info["last_token_usage"].(map[string]any)
		if usage == nil {
			usage, _ = info["total_token_usage"].(map[string]any)
		}
		if usage == nil {
			return Tokens{}, false
		}
		return tokensFromUsageMap(usage, true), true
	case "turn.completed":
		usage, _ := ev["usage"].(map[string]any)
		if usage == nil {
			return Tokens{}, false
		}
		return tokensFromUsageMap(usage, false), true
	}
	return Tokens{}, false
}

// tokensFromUsageMap reads `input_tokens`/`output_tokens`/etc. fields and
// computes `Total`. If `useExplicitTotal` is true and a `total_tokens` field
// is present, we use it directly; otherwise we sum input+output (legacy
// behaviour from the python `extract_session_entries` helper for
// turn.completed events).
func tokensFromUsageMap(usage map[string]any, useExplicitTotal bool) Tokens {
	input := toInt64(usage["input_tokens"])
	output := toInt64(usage["output_tokens"])
	cached := toInt64(usage["cached_input_tokens"])
	reasoning := toInt64(usage["reasoning_output_tokens"])
	var total int64
	if useExplicitTotal {
		if v, ok := usage["total_tokens"]; ok {
			total = toInt64(v)
		}
	}
	if total == 0 {
		total = input + output
	}
	return Tokens{Total: total, Input: input, Output: output, Cached: cached, Reasoning: reasoning}
}

func toInt64(v any) int64 {
	switch t := v.(type) {
	case nil:
		return 0
	case float64:
		if t < 0 {
			return 0
		}
		return int64(t)
	case float32:
		if t < 0 {
			return 0
		}
		return int64(t)
	case int:
		if t < 0 {
			return 0
		}
		return int64(t)
	case int64:
		if t < 0 {
			return 0
		}
		return t
	case json.Number:
		i, err := t.Int64()
		if err == nil {
			if i < 0 {
				return 0
			}
			return i
		}
		f, err := t.Float64()
		if err == nil && f >= 0 {
			return int64(f)
		}
	case string:
		s := strings.ReplaceAll(t, ",", "")
		if s == "" {
			return 0
		}
		i, err := strconv.ParseInt(s, 10, 64)
		if err == nil {
			if i < 0 {
				return 0
			}
			return i
		}
	}
	return 0
}
