// Package claude — usage.go ports the legacy bash + python token extraction
// from bin/clx.d/03-sync-50-usage.sh into typed Go.
//
// Claude Code stores its session history under ~/.claude/projects/**/*.jsonl
// (and a few stray files directly under ~/.claude/). Each JSONL line is one
// event; usage information appears in three shapes:
//
//   - `message.usage` nested under assistant turn entries (the common case).
//   - `usage` at the top level (raw API-response style).
//   - `result` events with flat `input_tokens`/`output_tokens` fields.
//
// Cache-related counters split into `cache_read_input_tokens` (already
// computed → "cached") and `cache_creation_input_tokens` (first-time write
// → "cache_creation"); the legacy bash sums both for the human-readable
// "(+ N cached)" string but keeps them as separate JSON keys on the wire.
//
// No `reasoning` field — Claude's API doesn't expose one.
package claude

import (
	"bufio"
	"encoding/json"
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
	Total         int64
	Input         int64
	Output        int64
	Cached        int64
	CacheCreation int64
}

// Add accumulates `other` into the receiver.
func (t *Tokens) Add(other Tokens) {
	t.Total += other.Total
	t.Input += other.Input
	t.Output += other.Output
	t.Cached += other.Cached
	t.CacheCreation += other.CacheCreation
}

// IsZero reports whether all counters are zero.
func (t Tokens) IsZero() bool {
	return t.Total == 0 && t.Input == 0 && t.Output == 0 && t.Cached == 0 && t.CacheCreation == 0
}

// ─── ANSI / control char stripping ────────────────────────────────────────────

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

// Claude Code's `--print` mode prints a "Token usage:" footer similar in
// shape to the upstream Codex one. We accept the same regex (without
// reasoning) so anything the bash wrapper used to scrape still works.
var tokenUsagePattern = regexp.MustCompile(
	`(?i)Token usage:\s*total=([\d,]+)\s+input=([\d,]+)(?:\s*\(\+\s*([\d,]+)\s*cached\))?\s+output=([\d,]+)`,
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

// ParseStdoutCapture scans `buf` for the most recent "Token usage:…" line.
// Returns ok=false if nothing matched (the usual case for interactive runs;
// fall back to JSONL discovery).
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
		return tok, true
	}
	return Tokens{}, false
}

// ─── JSONL session discovery + parsing ───────────────────────────────────────

// DiscoverSessions walks `roots` (typically ~/.claude/projects and ~/.claude)
// recursively and returns *.jsonl files modified at or after `since`.
// Roots that don't exist are skipped. Returned paths are deduplicated.
func DiscoverSessions(roots []string, since time.Time) ([]string, error) {
	type entry struct {
		path  string
		mtime time.Time
	}
	seen := make(map[string]struct{})
	var found []entry
	for _, root := range roots {
		info, err := os.Stat(root)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		if !info.IsDir() {
			continue
		}
		walkErr := filepath.WalkDir(root, func(path string, d fs.DirEntry, werr error) error {
			if werr != nil {
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
			abs, err := filepath.Abs(path)
			if err != nil {
				abs = path
			}
			if _, dup := seen[abs]; dup {
				return nil
			}
			st, err := d.Info()
			if err != nil {
				return nil
			}
			if st.ModTime().Before(since) {
				return nil
			}
			seen[abs] = struct{}{}
			found = append(found, entry{path: abs, mtime: st.ModTime()})
			return nil
		})
		if walkErr != nil {
			return nil, walkErr
		}
	}

	// Sort oldest → newest with deterministic tie-break.
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

// DefaultSessionRoots returns the legacy Claude Code session search roots:
// `~/.claude/projects/` and `~/.claude/`. If the home directory can't be
// resolved an empty slice is returned (caller should treat that as a no-op).
func DefaultSessionRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}
	return []string{
		filepath.Join(home, ".claude", "projects"),
		filepath.Join(home, ".claude"),
	}
}

// ParseSessionJSONL reads a Claude Code session JSONL file and sums usage
// fields from every event-row shape we know about. The legacy bash dedups
// against the immediately-previous (total,input,output,cached,cache_creation)
// signature; we match that.
//
// Unparseable lines are skipped silently.
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
		sig := [5]int64{entry.Total, entry.Input, entry.Output, entry.Cached, entry.CacheCreation}
		if haveLast && sig == lastSig {
			continue
		}
		lastSig = sig
		haveLast = true
		total.Add(entry)
	}
	if err := scanner.Err(); err != nil {
		return total, err
	}
	return total, nil
}

func extractJSONLEntry(ev map[string]any) (Tokens, bool) {
	// 1. Nested under message.usage (assistant turn entries).
	if msg, ok := ev["message"].(map[string]any); ok {
		if u, ok := msg["usage"].(map[string]any); ok {
			if tok, present := tokensFromUsageMap(u); present {
				return tok, true
			}
		}
	}
	// 2. Top-level usage (raw API response style).
	if u, ok := ev["usage"].(map[string]any); ok {
		if tok, present := tokensFromUsageMap(u); present {
			return tok, true
		}
	}
	// 3. Flat fields on a `result` event.
	if typ, _ := ev["type"].(string); typ == "result" {
		input := toInt64(ev["input_tokens"])
		output := toInt64(ev["output_tokens"])
		if input > 0 || output > 0 {
			return Tokens{Total: input + output, Input: input, Output: output}, true
		}
	}
	return Tokens{}, false
}

// tokensFromUsageMap builds a Tokens from the Anthropic API `usage` object.
// Returns present=false when input_tokens is missing (the legacy bash treats
// that as "this row has no usage info").
func tokensFromUsageMap(u map[string]any) (Tokens, bool) {
	if _, ok := u["input_tokens"]; !ok {
		return Tokens{}, false
	}
	input := toInt64(u["input_tokens"])
	output := toInt64(u["output_tokens"])
	cached := toInt64(u["cache_read_input_tokens"])
	cacheCreation := toInt64(u["cache_creation_input_tokens"])
	total := input + output
	return Tokens{Total: total, Input: input, Output: output, Cached: cached, CacheCreation: cacheCreation}, true
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
