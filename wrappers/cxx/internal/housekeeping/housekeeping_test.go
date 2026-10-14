package housekeeping

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionguard"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const idOld = "11111111-1111-4111-8111-111111111111"
const idKeep = "22222222-2222-4222-8222-222222222222"
const idChild = "33333333-3333-4333-8333-333333333333"

type fakeServer struct {
	p                               Protection
	reserveErr, releaseErr          error
	reservations, releases, reports int
	onReserve                       func()
}

func (f *fakeServer) Inspect(context.Context) (Protection, error) { return f.p, nil }
func (f *fakeServer) Reserve(context.Context, string) (Protection, error) {
	f.reservations++
	if f.onReserve != nil {
		f.onReserve()
	}
	return f.p, f.reserveErr
}
func (f *fakeServer) Release(context.Context, string) error { f.releases++; return f.releaseErr }
func (f *fakeServer) Report(context.Context, Result) error  { f.reports++; return nil }
func testServer() *fakeServer {
	return &fakeServer{p: Protection{Policy: Policy{Enabled: true, RetentionDays: 30, MaxBytes: 5 << 30, MinAgeDays: 7}}}
}
func fileAt(t *testing.T, root, path string, age int) string {
	t.Helper()
	p := filepath.Join(root, path)
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("{}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	mt := time.Now().Add(-time.Duration(age) * 24 * time.Hour)
	if err := os.Chtimes(p, mt, mt); err != nil {
		t.Fatal(err)
	}
	return p
}
func idle(string) (bool, error) { return false, nil }
func opts(root, engine string, server *fakeServer) Options {
	return Options{Root: root, Engine: engine, Server: server, Busy: idle}
}
func exists(t *testing.T, p string, want bool) {
	t.Helper()
	_, err := os.Stat(p)
	if (err == nil) != want {
		t.Fatalf("exists %s: %v", p, err)
	}
}
func TestSelectionAgeBudgetAndProtection(t *testing.T) {
	now := time.Now()
	s := []session{{ID: "old", Bytes: 2 << 30, Modified: now.Add(-31 * 24 * time.Hour)}, {ID: "budget", Bytes: 2 << 30, Modified: now.Add(-8 * 24 * time.Hour)}, {ID: "young", Bytes: 4 << 30, Modified: now.Add(-6 * 24 * time.Hour)}, {ID: "pin", Bytes: 8 << 30, Modified: now.Add(-90 * 24 * time.Hour), Protected: true}}
	selected, total, p := selectSessions(s, testServer().p.Policy, now)
	if len(selected) != 2 || selected[0].ID != "old" || selected[1].ID != "budget" || total != 16<<30 || p != 1 {
		t.Fatalf("selection %+v %d %d", selected, total, p)
	}
}
func TestThreeEngineBundlesAndIndexes(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			root := t.TempDir()
			var old, keep string
			switch engine {
			case "codex":
				old = fileAt(t, root, "sessions/2026/01/01/rollout-date-"+idOld+".jsonl", 40)
				keep = fileAt(t, root, "sessions/2026/01/01/rollout-date-"+idKeep+".jsonl", 1)
				_ = fileAt(t, root, "shell_snapshots/"+idOld+".sh", 40)
				_ = writeJSON(filepath.Join(root, ".codex-global-state.json"), map[string]any{"projectless-thread-ids": []string{idOld, idKeep}, "other": "preserved"})
				_ = os.WriteFile(filepath.Join(root, "session_index.jsonl"), []byte(`{"id":"`+idOld+`"}`+"\n"+`{"id":"`+idKeep+`"}`+"\n"), 0600)
			case "claude":
				old = fileAt(t, root, "projects/project/"+idOld+".jsonl", 40)
				keep = fileAt(t, root, "projects/project/"+idKeep+".jsonl", 1)
				_ = fileAt(t, root, "projects/project/"+idOld+"/subagents/agent-child.jsonl", 40)
				_ = fileAt(t, root, "projects/project/memory/MEMORY.md", 40)
				_ = writeJSON(filepath.Join(root, "projects/project/sessions-index.json"), map[string]any{"version": 1, "entries": []any{map[string]any{"sessionId": idOld}, map[string]any{"sessionId": idKeep}}})
			case "grok":
				old = fileAt(t, root, "sessions/project/"+idOld+"/events.jsonl", 40)
				keep = fileAt(t, root, "sessions/project/"+idKeep+"/events.jsonl", 1)
				summary := fileAt(t, root, "sessions/project/"+idOld+"/summary.json", 40)
				_ = os.WriteFile(summary, []byte(`{"info":{"id":"`+idOld+`"}}`), 0600)
				mt := time.Now().Add(-40 * 24 * time.Hour)
				_ = os.Chtimes(summary, mt, mt)
			}
			f := testServer()
			o := opts(root, engine, f)
			o.DryRun = true
			r, err := Run(context.Background(), o)
			if err != nil || r.Candidates != 1 {
				t.Fatalf("dry run %+v %v", r, err)
			}
			exists(t, old, true)
			o.DryRun = false
			r, err = Run(context.Background(), o)
			if err != nil || r.Deleted != 1 || r.FreedBytes <= 0 {
				t.Fatalf("run %+v %v", r, err)
			}
			exists(t, old, false)
			exists(t, keep, true)
			r, err = Run(context.Background(), o)
			if err != nil || r.Deleted != 0 {
				t.Fatalf("second run %+v %v", r, err)
			}
			if engine == "claude" {
				exists(t, filepath.Join(root, "projects/project/memory/MEMORY.md"), true)
			}
		})
	}
}
func TestFleetBindingAndPins(t *testing.T) {
	root := t.TempDir()
	old := fileAt(t, root, "sessions/x/rollout-date-"+idOld+".jsonl", 40)
	f := testServer()
	f.p.IDs = []string{idOld}
	r, err := Run(context.Background(), opts(root, "codex", f))
	if err != nil || r.Protected != 1 || r.Deleted != 0 {
		t.Fatalf("protected %+v %v", r, err)
	}
	exists(t, old, true)
	f.p.IDs = nil
	if err = Pin(root, idOld, true); err != nil {
		t.Fatal(err)
	}
	r, err = Run(context.Background(), opts(root, "codex", f))
	if err != nil || r.Protected != 1 {
		t.Fatalf("pin %+v %v", r, err)
	}
}
func TestNativeGuardAndProcessSkip(t *testing.T) {
	root := t.TempDir()
	old := fileAt(t, root, "sessions/x/rollout-date-"+idOld+".jsonl", 40)
	guard, err := sessionguard.LaunchAt(root)
	if err != nil {
		t.Fatal(err)
	}
	o := opts(root, "codex", testServer())
	r, err := Run(context.Background(), o)
	if err != nil || r.Outcome != "skipped" {
		t.Fatalf("guard %+v %v", r, err)
	}
	guard.Release()
	o.Busy = func(string) (bool, error) { return true, nil }
	r, err = Run(context.Background(), o)
	if err != nil || r.Reason != "native_process_active" {
		t.Fatalf("process %+v %v", r, err)
	}
	exists(t, old, true)
}
func TestAmbiguousReservationRecovery(t *testing.T) {
	root := t.TempDir()
	old := fileAt(t, root, "sessions/x/rollout-date-"+idOld+".jsonl", 40)
	f := testServer()
	f.reserveErr = errors.New("lost HTTP response")
	_, err := Run(context.Background(), opts(root, "codex", f))
	if err == nil {
		t.Fatal("expected reservation failure")
	}
	exists(t, old, true)
	if guard, err := sessionguard.LaunchAt(root); err == nil {
		guard.Release()
		t.Fatal("journal did not fence launch")
	}
	f.reserveErr = nil
	r, err := Run(context.Background(), opts(root, "codex", f))
	if err != nil || r.Outcome != "recovered" || r.Deleted != 0 {
		t.Fatalf("recover %+v %v", r, err)
	}
	exists(t, old, true)
	r, err = Run(context.Background(), opts(root, "codex", f))
	if err != nil || r.Deleted != 1 {
		t.Fatalf("retry %+v %v", r, err)
	}
}
func TestReleaseFailureRepeatsSameJournal(t *testing.T) {
	root := t.TempDir()
	old := fileAt(t, root, "sessions/x/rollout-date-"+idOld+".jsonl", 40)
	f := testServer()
	f.releaseErr = errors.New("lost release response")
	_, err := Run(context.Background(), opts(root, "codex", f))
	if err == nil {
		t.Fatal("expected release failure")
	}
	exists(t, old, false)
	raw, _ := os.ReadFile(filepath.Join(root, ".cxx-housekeeping/journal.json"))
	var j journal
	_ = json.Unmarshal(raw, &j)
	if j.Phase != "purging" {
		t.Fatal(j.Phase)
	}
	f.releaseErr = nil
	r, err := Run(context.Background(), opts(root, "codex", f))
	if err != nil || r.Outcome != "recovered" {
		t.Fatalf("recover %+v %v", r, err)
	}
	exists(t, filepath.Join(root, ".cxx-housekeeping/journal.json"), false)
}
func TestRejectUnknownSchemaAndSymlinks(t *testing.T) {
	root := t.TempDir()
	old := fileAt(t, root, "sessions/x/rollout-date-"+idOld+".jsonl", 40)
	_ = fileAt(t, root, "state_999.sqlite", 1)
	f := testServer()
	r, err := Run(context.Background(), opts(root, "codex", f))
	// An unknown layout is a fail-closed skip, not a maintenance failure.
	if err != nil || r.Outcome != "skipped" || r.Reason != "unsupported_native_database" || !strings.Contains(r.Detail, "state_999.sqlite") {
		t.Fatalf("%+v %v", r, err)
	}
	if f.reports != 1 || f.reservations != 0 {
		t.Fatalf("skip not reported centrally or reserved: %+v", f)
	}
	exists(t, old, true)
	_ = os.Remove(filepath.Join(root, "state_999.sqlite"))
	_ = os.Symlink(t.TempDir(), filepath.Join(root, "sessions/foreign"))
	_, err = Run(context.Background(), opts(root, "codex", testServer()))
	if err == nil {
		t.Fatal("symlink accepted")
	}
	exists(t, old, true)
}
func TestRecencyAndSQLiteCascade(t *testing.T) {
	root := t.TempDir()
	old := fileAt(t, root, "sessions/x/rollout-date-"+idOld+".jsonl", 40)
	keep := fileAt(t, root, "sessions/x/rollout-date-"+idKeep+".jsonl", 40)
	p := filepath.Join(root, "state_5.sqlite")
	db, err := openTestDB(p)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,updated_at INTEGER,is_pinned INTEGER);CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);CREATE TABLE thread_dynamic_tools(thread_id TEXT REFERENCES threads(id),value TEXT);INSERT INTO threads VALUES('` + idOld + `',0,0),('` + idKeep + `',0,1);INSERT INTO thread_dynamic_tools VALUES('` + idOld + `','old'),('` + idKeep + `','keep')`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	r, err := Run(context.Background(), opts(root, "codex", testServer()))
	if err != nil || r.Deleted != 1 || r.Protected != 1 {
		t.Fatalf("database %+v %v", r, err)
	}
	exists(t, old, false)
	exists(t, keep, true)
	db, err = openDB(p, false)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	_ = db.QueryRow(`SELECT count(*) FROM threads`).Scan(&n)
	if n != 1 {
		t.Fatal(n)
	}
	_ = db.QueryRow(`SELECT count(*) FROM thread_dynamic_tools`).Scan(&n)
	if n != 1 {
		t.Fatal(n)
	}
}
func TestChildRecencyProtectsParent(t *testing.T) {
	root := t.TempDir()
	_ = fileAt(t, root, "sessions/x/rollout-date-"+idOld+".jsonl", 40)
	_ = fileAt(t, root, "sessions/x/rollout-date-"+idChild+".jsonl", 1)
	db, err := openTestDB(filepath.Join(root, "state_5.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,updated_at INTEGER,is_pinned INTEGER);CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT);INSERT INTO thread_spawn_edges VALUES('` + idOld + `','` + idChild + `')`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	r, err := Run(context.Background(), opts(root, "codex", testServer()))
	if err != nil || r.Candidates != 0 {
		t.Fatalf("child %+v %v", r, err)
	}
}
func TestDailyCoalescingAndDisabled(t *testing.T) {
	root := t.TempDir()
	_ = fileAt(t, root, "sessions/x/rollout-date-"+idOld+".jsonl", 40)
	f := testServer()
	f.p.Policy.Enabled = false
	r, err := Run(context.Background(), opts(root, "codex", f))
	if err != nil || r.Outcome != "disabled" {
		t.Fatal(r, err)
	}
	f.p.Policy.Enabled = true
	o := opts(root, "codex", f)
	o.Automatic = true
	_, err = Run(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	r, err = Run(context.Background(), o)
	if err != nil || r.Outcome != "not_due" {
		t.Fatal(r, err)
	}
}
func TestGrokForkSharesRecencyAndPin(t *testing.T) {
	root := t.TempDir()
	for _, id := range []string{idOld, idChild} {
		p := fileAt(t, root, "sessions/p/"+id+"/summary.json", 40)
		meta := map[string]any{"info": map[string]any{"id": id}}
		if id == idChild {
			meta["parent_session_id"] = idOld
		}
		raw, _ := json.Marshal(meta)
		_ = os.WriteFile(p, raw, 0600)
		mt := time.Now().Add(-40 * 24 * time.Hour)
		if id == idChild {
			mt = time.Now()
		}
		_ = os.Chtimes(p, mt, mt)
	}
	f := testServer()
	r, err := Run(context.Background(), opts(root, "grok", f))
	if err != nil || r.Candidates != 0 {
		t.Fatal(r, err)
	}
	f.p.IDs = []string{idChild}
	r, err = Run(context.Background(), opts(root, "grok", f))
	if err != nil || r.Protected != 1 {
		t.Fatal(r, err)
	}
}
func TestMetadataSymlinkNeverWritesOutsideHome(t *testing.T) {
	root := t.TempDir()
	external := t.TempDir()
	_ = os.Symlink(external, filepath.Join(root, ".cxx-housekeeping"))
	_, err := Run(context.Background(), opts(root, "codex", testServer()))
	if err == nil {
		t.Fatal("metadata symlink accepted")
	}
	files, err := os.ReadDir(external)
	if err != nil || len(files) != 0 {
		t.Fatal(files, err)
	}
}
func TestMalformedIndexNeverQuarantines(t *testing.T) {
	root := t.TempDir()
	old := fileAt(t, root, "sessions/x/rollout-date-"+idOld+".jsonl", 40)
	_ = os.WriteFile(filepath.Join(root, "session_index.jsonl"), []byte("broken tail"), 0600)
	r, err := Run(context.Background(), opts(root, "codex", testServer()))
	if err == nil || r.Reason != "unsupported_native_index" {
		t.Fatal(r, err)
	}
	exists(t, old, true)
	exists(t, filepath.Join(root, ".cxx-housekeeping/journal.json"), false)
}
func TestChangedSelectionAbortsBeforeFirstRename(t *testing.T) {
	root := t.TempDir()
	old := fileAt(t, root, "sessions/x/rollout-date-"+idOld+".jsonl", 40)
	st, _ := os.Stat(old)
	j := journal{Token: idKeep, Engine: "codex", Phase: "moving", IDs: []string{idOld}, Moves: []move{{old, filepath.Join(root, ".cxx-housekeeping/quarantine", idKeep, "sessions/x/rollout-date-"+idOld+".jsonl"), st.Size(), st.ModTime()}}}
	path := filepath.Join(root, ".cxx-housekeeping/journal.json")
	_ = writeJSON(path, j)
	_ = os.WriteFile(old, []byte("changed"), 0600)
	err := completeJournal(context.Background(), root, path, &j, nil, testServer())
	if err == nil {
		t.Fatal("changed snapshot accepted")
	}
	exists(t, old, true)
	exists(t, path, false)
}
