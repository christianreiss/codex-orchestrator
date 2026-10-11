package housekeeping

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionguard"
)

func recoveryFixture(t *testing.T, phase string) (string, string, *journal) {
	t.Helper()
	root := t.TempDir()
	j := &journal{Version: 2, Engine: "codex", Token: idKeep, Phase: phase, IDs: []string{idOld, idChild}, Count: 2}
	for _, id := range j.IDs {
		original := fileAt(t, root, "sessions/x/rollout-date-"+id+".jsonl", 40)
		st, err := os.Stat(original)
		if err != nil {
			t.Fatal(err)
		}
		rel, _ := filepath.Rel(root, original)
		j.Moves = append(j.Moves, move{original, filepath.Join(root, ".cxx-housekeeping/quarantine", j.Token, rel), st.Size(), st.ModTime()})
		j.Bytes += st.Size()
	}
	path := filepath.Join(root, ".cxx-housekeeping/journal.json")
	if err := writeJSON(path, j); err != nil {
		t.Fatal(err)
	}
	return root, path, j
}
func quarantineFirst(t *testing.T, j *journal) {
	t.Helper()
	m := j.Moves[0]
	if err := os.MkdirAll(filepath.Dir(m.Quarantine), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(m.Original, m.Quarantine); err != nil {
		t.Fatal(err)
	}
}
func TestPartialMoveChangedOriginalRollsBackAndUnblocksLaunch(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(map[bool]string{false: "current", true: "legacy"}[legacy], func(t *testing.T) {
			root, path, j := recoveryFixture(t, "moving")
			if legacy {
				j.Version = 0
				if err := writeJSON(path, j); err != nil {
					t.Fatal(err)
				}
			}
			quarantineFirst(t, j)
			if err := os.WriteFile(j.Moves[1].Original, []byte("new native content\n"), 0600); err != nil {
				t.Fatal(err)
			}
			r, err := Run(context.Background(), opts(root, "codex", testServer()))
			if err != nil || r.Outcome != "rolled_back" || r.Deleted != 0 || r.FreedBytes != 0 {
				t.Fatal(r, err)
			}
			for i, m := range j.Moves {
				raw, err := os.ReadFile(m.Original)
				if err != nil {
					t.Fatal(err)
				}
				want := "{}\n"
				if i == 1 {
					want = "new native content\n"
				}
				if string(raw) != want {
					t.Fatalf("lost transcript %q", raw)
				}
				exists(t, m.Quarantine, false)
			}
			exists(t, path, false)
			guard, err := sessionguard.LaunchAt(root)
			if err != nil {
				t.Fatal(err)
			}
			_ = guard.Release()
		})
	}
}
func TestRollbackPreservesRecreatedOriginalAndConflictingQuarantine(t *testing.T) {
	root, path, j := recoveryFixture(t, "moving")
	quarantineFirst(t, j)
	if err := os.WriteFile(j.Moves[0].Original, []byte("recreated"), 0600); err != nil {
		t.Fatal(err)
	}
	f := testServer()
	f.releaseErr = errors.New("release lost")
	if err := completeJournal(context.Background(), root, path, j, nil, f); err == nil {
		t.Fatal("release failure hidden")
	}
	exists(t, path, true)
	f.releaseErr = nil
	r, err := Run(context.Background(), opts(root, "codex", f))
	if err != nil || r.Outcome != "rolled_back" {
		t.Fatal(r, err)
	}
	raw, _ := os.ReadFile(j.Moves[0].Original)
	if string(raw) != "recreated" {
		t.Fatal(string(raw))
	}
	raw, _ = os.ReadFile(j.Moves[0].Quarantine)
	if string(raw) != "{}\n" {
		t.Fatal(string(raw))
	}
	exists(t, filepath.Join(root, ".cxx-housekeeping/recovered", j.Token+".json"), true)
	exists(t, path, false)
}
func TestHousekeepingRechecksProcessesAfterReservation(t *testing.T) {
	for _, recovery := range []bool{false, true} {
		t.Run(map[bool]string{false: "new", true: "recovery"}[recovery], func(t *testing.T) {
			root, path, j := recoveryFixture(t, "moving")
			if !recovery {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			}
			f := testServer()
			busy := false
			f.onReserve = func() { busy = true }
			o := opts(root, "codex", f)
			o.Busy = func(string) (bool, error) { return busy, nil }
			r, err := Run(context.Background(), o)
			if recovery && err == nil {
				t.Fatal("recovery ignored newly active native process", r)
			}
			if !recovery && (err != nil || r.Outcome != "skipped") {
				t.Fatal(r, err)
			}
			for _, m := range j.Moves {
				exists(t, m.Original, true)
				exists(t, m.Quarantine, false)
			}
			exists(t, path, recovery)
		})
	}
}
func TestIndexingRecoveryNeverRestoresRecreatedTranscript(t *testing.T) {
	root, path, j := recoveryFixture(t, "indexing")
	for _, m := range j.Moves {
		_ = os.MkdirAll(filepath.Dir(m.Quarantine), 0700)
		if err := os.Rename(m.Original, m.Quarantine); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(j.Moves[1].Original, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := completeJournal(context.Background(), root, path, j, nil, testServer()); err == nil {
		t.Fatal("ambiguous index state accepted")
	}
	exists(t, path, true)
	for _, m := range j.Moves {
		exists(t, m.Quarantine, true)
	}
}
func TestNativeArgvRecognizesSpacedPathsAndInterpreters(t *testing.T) {
	cases := []struct {
		engine string
		argv   []string
		want   bool
	}{
		{"codex", []string{"/opt/native clients/codex", "exec"}, true},
		{"codex", []string{"/bin/sh", "/opt/native clients/codex", "--version"}, true},
		{"grok", []string{"/usr/bin/env", "-u", "TOKEN", "HOME=/tmp/home", "/opt/grok"}, true},
		{"claude", []string{"node", "/opt/claude-code/cli.js"}, true},
		{"claude", []string{"node", "/opt/other.js", "prompt /engines/claude/"}, false},
		{"codex", []string{"/bin/sh", "-c", "echo codex"}, false},
		{"codex", []string{"/usr/bin/echo", "/opt/codex"}, false},
	}
	for _, tc := range cases {
		if got := nativeArgv(tc.engine, tc.argv); got != tc.want {
			t.Errorf("%s %q=%v", tc.engine, tc.argv, got)
		}
	}
}
