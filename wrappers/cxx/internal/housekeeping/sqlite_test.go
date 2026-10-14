package housekeeping

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func openTestDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err == nil {
		err = db.Ping()
	}
	return db, err
}
func TestGrokExternalFTSRemoval(t *testing.T) {
	root := t.TempDir()
	_ = fileAt(t, root, "sessions/project/"+idOld+"/events.jsonl", 40)
	summary := fileAt(t, root, "sessions/project/"+idOld+"/summary.json", 40)
	_ = os.WriteFile(summary, []byte(`{"info":{"id":"`+idOld+`"}}`), 0600)
	mt := time.Now().Add(-40 * 24 * time.Hour)
	_ = os.Chtimes(summary, mt, mt)
	p := filepath.Join(root, "sessions/session_search.sqlite")
	db, err := openTestDB(p)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE session_docs(session_id TEXT PRIMARY KEY,title TEXT,content TEXT);CREATE VIRTUAL TABLE session_docs_fts USING fts5(title,content,content='session_docs',content_rowid='rowid');INSERT INTO session_docs VALUES('` + idOld + `','old','obsolete'),('` + idKeep + `','keep','retained');INSERT INTO session_docs_fts(rowid,title,content) SELECT rowid,title,content FROM session_docs;`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	_, err = Run(context.Background(), opts(root, "grok", testServer()))
	if err != nil {
		t.Fatal(err)
	}
	db, err = openDB(p, false)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	err = db.QueryRow(`SELECT count(*) FROM session_docs_fts WHERE session_docs_fts MATCH 'obsolete'`).Scan(&n)
	if err != nil || n != 0 {
		t.Fatal(n, err)
	}
	err = db.QueryRow(`SELECT count(*) FROM session_docs_fts WHERE session_docs_fts MATCH 'retained'`).Scan(&n)
	if err != nil || n != 1 {
		t.Fatal(n, err)
	}
}
func TestOpenGoalAndQueueProtection(t *testing.T) {
	root := t.TempDir()
	old := fileAt(t, root, "sessions/x/rollout-date-"+idOld+".jsonl", 40)
	p := filepath.Join(root, "goals_1.sqlite")
	db, err := openTestDB(p)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE thread_goals(thread_id TEXT,status TEXT);INSERT INTO thread_goals VALUES('` + idOld + `','paused')`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	r, err := Run(context.Background(), opts(root, "codex", testServer()))
	if err != nil || r.Protected != 1 {
		t.Fatal(r, err)
	}
	if _, err = os.Stat(old); err != nil {
		t.Fatal(err)
	}
}

func createDB(t *testing.T, path, ddl string) {
	t.Helper()
	db, err := openTestDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(ddl); err != nil {
		t.Fatal(err)
	}
}

// Codex 0.162.1 layout as observed on a live host (2026-10-14): only the
// columns housekeeping reads or deletes by matter.
const codex0162State = `CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,created_at INTEGER,updated_at INTEGER,is_pinned INTEGER NOT NULL DEFAULT 0);CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);CREATE TABLE thread_dynamic_tools(thread_id TEXT,position INTEGER);`

func TestCodex0162LayoutWithSupersededLogsIsCleaned(t *testing.T) {
	root := t.TempDir()
	old := fileAt(t, root, "sessions/x/rollout-date-"+idOld+".jsonl", 40)
	createDB(t, filepath.Join(root, "state_5.sqlite"), codex0162State+`INSERT INTO threads VALUES('`+idOld+`','',0,0,0);`)
	createDB(t, filepath.Join(root, "logs_2.sqlite"), `CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,thread_id TEXT);INSERT INTO logs(thread_id) VALUES('`+idOld+`');`)
	// A pre-migration log store Codex leaves behind: never opened or modified.
	legacy := filepath.Join(root, "logs_1.sqlite")
	createDB(t, legacy, `CREATE TABLE something_else(x TEXT);`)
	before, _ := os.ReadFile(legacy)
	r, err := Run(context.Background(), opts(root, "codex", testServer()))
	if err != nil || r.Outcome != "completed" || r.Deleted != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	exists(t, old, false)
	after, _ := os.ReadFile(legacy)
	if string(before) != string(after) {
		t.Fatal("superseded database was modified")
	}
}

func TestUnsupportedNativeSchemaSkipsWithoutFailure(t *testing.T) {
	root := t.TempDir()
	old := fileAt(t, root, "sessions/x/rollout-date-"+idOld+".jsonl", 40)
	createDB(t, filepath.Join(root, "state_5.sqlite"), `CREATE TABLE threads(id TEXT PRIMARY KEY,updated_at INTEGER);`)
	f := testServer()
	r, err := Run(context.Background(), opts(root, "codex", f))
	if err != nil || r.Outcome != "skipped" || r.Reason != "unsupported_native_database" || !strings.Contains(r.Detail, "state_5.sqlite/threads: missing is_pinned") {
		t.Fatalf("%+v %v", r, err)
	}
	exists(t, old, true)
	var out strings.Builder
	render(&out, r)
	if !strings.Contains(out.String(), "missing is_pinned") {
		t.Fatalf("detail hidden from cron.log: %q", out.String())
	}
	// A logs_1 without a newer supported sibling is still an unknown layout.
	root = t.TempDir()
	createDB(t, filepath.Join(root, "logs_1.sqlite"), `CREATE TABLE logs(thread_id TEXT);`)
	if r, err = Run(context.Background(), opts(root, "codex", testServer())); err != nil || r.Reason != "unsupported_native_database" {
		t.Fatalf("%+v %v", r, err)
	}
}
