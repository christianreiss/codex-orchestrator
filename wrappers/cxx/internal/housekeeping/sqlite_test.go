package housekeeping

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
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
