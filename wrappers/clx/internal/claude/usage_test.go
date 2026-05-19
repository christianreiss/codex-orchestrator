package claude

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseStdoutCapture_Table(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want Tokens
		ok   bool
	}{
		{name: "empty", in: "", ok: false},
		{name: "no match", in: "hello\n", ok: false},
		{
			name: "legacy bash line",
			in:   "Token usage: total=900 input=700 output=200\n",
			want: Tokens{Total: 900, Input: 700, Output: 200},
			ok:   true,
		},
		{
			name: "with cached",
			in:   "Token usage: total=1200 input=900 (+ 100 cached) output=300\n",
			want: Tokens{Total: 1200, Input: 900, Cached: 100, Output: 300},
			ok:   true,
		},
		{
			name: "ansi-coloured",
			in:   "\x1b[1;32mToken usage:\x1b[0m total=42 input=20 output=22\n",
			want: Tokens{Total: 42, Input: 20, Output: 22},
			ok:   true,
		},
		{
			name: "uses last of multiple",
			in:   "Token usage: total=10 input=5 output=5\nToken usage: total=99 input=50 output=49\n",
			want: Tokens{Total: 99, Input: 50, Output: 49},
			ok:   true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ParseStdoutCapture([]byte(tc.in))
			if ok != tc.ok {
				t.Fatalf("ok=%v want %v (got=%+v)", ok, tc.ok, got)
			}
			if ok && got != tc.want {
				t.Fatalf("tokens=%+v want=%+v", got, tc.want)
			}
		})
	}
}

func TestParseSessionJSONL_Fixture(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	body := strings.Join([]string{
		// Assistant turn with message.usage.
		`{"type":"assistant","message":{"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}`,
		// Duplicate signature → must dedupe.
		`{"type":"assistant","message":{"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}`,
		// Top-level usage event.
		`{"usage":{"input_tokens":40,"output_tokens":20}}`,
		// Result event with flat fields.
		`{"type":"result","input_tokens":7,"output_tokens":3}`,
		// Unrelated line.
		`{"type":"user","message":{"content":"hi"}}`,
		// Garbage.
		`not json`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := ParseSessionJSONL(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// Expected: 150 + 60 + 10 = 220 total
	//           100 + 40 + 7 = 147 input
	//           50 + 20 + 3  = 73 output
	//           10 cached, 5 cache_creation
	want := Tokens{Total: 220, Input: 147, Output: 73, Cached: 10, CacheCreation: 5}
	if got != want {
		t.Fatalf("got=%+v want=%+v", got, want)
	}
}

func TestDiscoverSessions_MtimeFilter(t *testing.T) {
	root := t.TempDir()
	old := filepath.Join(root, "old.jsonl")
	newer := filepath.Join(root, "new.jsonl")
	other := filepath.Join(root, "ignore.txt")
	for _, p := range []string{old, newer, other} {
		if err := os.WriteFile(p, []byte("{}\n"), 0o644); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
	}
	past := time.Now().Add(-2 * time.Hour)
	future := time.Now().Add(2 * time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatalf("chtimes old: %v", err)
	}
	if err := os.Chtimes(newer, future, future); err != nil {
		t.Fatalf("chtimes new: %v", err)
	}

	got, err := DiscoverSessions([]string{root}, time.Now())
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(got) != 1 || filepath.Base(got[0]) != "new.jsonl" {
		t.Fatalf("got=%v want [new.jsonl]", got)
	}
}

func TestDiscoverSessions_DedupAcrossRoots(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "projects", "a")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	jsonl := filepath.Join(nested, "x.jsonl")
	if err := os.WriteFile(jsonl, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	// Both roots overlap (one is the parent of the other).
	got, err := DiscoverSessions([]string{root, filepath.Join(root, "projects")}, time.Unix(0, 0))
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 file (deduped) got %d (%v)", len(got), got)
	}
}

func TestDiscoverSessions_MissingRoots(t *testing.T) {
	got, err := DiscoverSessions([]string{filepath.Join(t.TempDir(), "nope")}, time.Now())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got=%v want empty", got)
	}
}
