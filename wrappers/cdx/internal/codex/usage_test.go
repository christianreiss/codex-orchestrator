package codex

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
		{
			name: "empty input",
			in:   "",
			ok:   false,
		},
		{
			name: "no match",
			in:   "hello world\nlooks like nothing here\n",
			ok:   false,
		},
		{
			name: "legacy bash line",
			in:   "blah\nToken usage: total=1500 input=1000 output=500\nbye\n",
			want: Tokens{Total: 1500, Input: 1000, Output: 500},
			ok:   true,
		},
		{
			name: "ansi-coloured line",
			in:   "\x1b[1;32mToken usage:\x1b[0m total=2,500 input=1,800 (+ 200 cached) output=700\n",
			want: Tokens{Total: 2500, Input: 1800, Cached: 200, Output: 700},
			ok:   true,
		},
		{
			name: "reasoning included",
			in:   "Token usage: total=4000 input=2500 (+ 100 cached) output=1500 (reasoning 300)\n",
			want: Tokens{Total: 4000, Input: 2500, Cached: 100, Output: 1500, Reasoning: 300},
			ok:   true,
		},
		{
			name: "reasoning without cached",
			in:   "Token usage: total=400 input=250 output=150 (reasoning 75)\n",
			want: Tokens{Total: 400, Input: 250, Output: 150, Reasoning: 75},
			ok:   true,
		},
		{
			name: "multiple lines uses last",
			in:   "Token usage: total=100 input=50 output=50\nToken usage: total=500 input=300 output=200\n",
			want: Tokens{Total: 500, Input: 300, Output: 200},
			ok:   true,
		},
		{
			name: "OSC noise stripped",
			in:   "\x1b]0;title\x07Token usage: total=42 input=20 output=22\n",
			want: Tokens{Total: 42, Input: 20, Output: 22},
			ok:   true,
		},
		{
			name: "case insensitive match",
			in:   "TOKEN USAGE: total=10 input=4 output=6\n",
			want: Tokens{Total: 10, Input: 4, Output: 6},
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
				t.Fatalf("tokens=%+v want %+v", got, tc.want)
			}
		})
	}
}

func TestParseSessionJSONL_Fixture(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	body := strings.Join([]string{
		// First token_count event: per-turn delta.
		`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150,"cached_input_tokens":10,"reasoning_output_tokens":5}}}}`,
		// Second token_count event with same signature → must be deduped.
		`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150,"cached_input_tokens":10,"reasoning_output_tokens":5}}}}`,
		// Third token_count event, larger turn.
		`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"output_tokens":80,"total_tokens":280,"cached_input_tokens":20,"reasoning_output_tokens":15}}}}`,
		// turn.completed event (no total_tokens — synthesised as input+output).
		`{"type":"turn.completed","usage":{"input_tokens":40,"output_tokens":20,"cached_input_tokens":5}}`,
		// Garbage line — should be skipped.
		`{not even json`,
		// Unrelated event — should be skipped.
		`{"type":"prompt","payload":{"text":"hi"}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	got, err := ParseSessionJSONL(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// Expected: 150 + 280 + 60 (=40+20) = 490 total
	//           100 + 200 + 40 = 340 input
	//           50 + 80 + 20  = 150 output
	//           10 + 20 + 5   = 35 cached
	//           5 + 15        = 20 reasoning
	want := Tokens{Total: 490, Input: 340, Output: 150, Cached: 35, Reasoning: 20}
	if got != want {
		t.Fatalf("got=%+v want=%+v", got, want)
	}
}

func TestParseSessionJSONL_MissingFile(t *testing.T) {
	_, err := ParseSessionJSONL(filepath.Join(t.TempDir(), "does-not-exist.jsonl"))
	if err == nil {
		t.Fatal("expected error on missing file")
	}
}

func TestDiscoverSessions_FilterByMtime(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "old.jsonl")
	newer := filepath.Join(dir, "new.jsonl")
	other := filepath.Join(dir, "notjsonl.txt")
	for _, p := range []string{old, newer, other} {
		if err := os.WriteFile(p, []byte("{}\n"), 0o644); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
	}
	// Anchor times explicitly so we don't race the test clock.
	past := time.Now().Add(-2 * time.Hour)
	future := time.Now().Add(2 * time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatalf("chtimes old: %v", err)
	}
	if err := os.Chtimes(newer, future, future); err != nil {
		t.Fatalf("chtimes new: %v", err)
	}
	// `since` halfway between → only `newer` qualifies.
	since := time.Now()
	got, err := DiscoverSessions(dir, since)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 file got %d (%v)", len(got), got)
	}
	if filepath.Base(got[0]) != "new.jsonl" {
		t.Fatalf("got=%v want new.jsonl", got)
	}

	// Both files when `since` is in the deep past.
	all, err := DiscoverSessions(dir, time.Unix(0, 0))
	if err != nil {
		t.Fatalf("discover all: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("want 2 files got %d (%v)", len(all), all)
	}
}

func TestDiscoverSessions_Recursive(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "2026", "05")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	nested := filepath.Join(sub, "session.jsonl")
	if err := os.WriteFile(nested, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := DiscoverSessions(dir, time.Unix(0, 0))
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(got) != 1 || got[0] != nested {
		t.Fatalf("got=%v want=%v", got, []string{nested})
	}
}

func TestDiscoverSessions_MissingDirIsNotError(t *testing.T) {
	got, err := DiscoverSessions(filepath.Join(t.TempDir(), "nope"), time.Now())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got=%v want empty", got)
	}
}
