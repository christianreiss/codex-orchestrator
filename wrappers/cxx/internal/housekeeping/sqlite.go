package housekeeping

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	_ "modernc.org/sqlite"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type database struct {
	path   string
	tables map[string]map[string]bool
}

func openDB(path string, write bool) (*sql.DB, error) {
	mode := "ro"
	if write {
		mode = "rw"
	}
	u := url.URL{Scheme: "file", Path: path}
	q := u.Query()
	q.Set("mode", mode)
	q.Add("_pragma", "busy_timeout(1000)")
	q.Add("_pragma", "foreign_keys(1)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err == nil {
		db.SetMaxOpenConns(1)
		err = db.Ping()
	}
	if err != nil && db != nil {
		db.Close()
	}
	return db, err
}
func inspectDB(root, path string) (database, error) {
	if err := safePath(root, path); err != nil {
		return database{}, err
	}
	db, err := openDB(path, false)
	if err != nil {
		return database{}, err
	}
	defer db.Close()
	result := database{path: path, tables: map[string]map[string]bool{}}
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		return result, err
	}
	var names []string
	for rows.Next() {
		var n string
		if err = rows.Scan(&n); err != nil {
			rows.Close()
			return result, err
		}
		names = append(names, n)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	for _, n := range names {
		rs, err := db.Query(`PRAGMA table_info(` + quote(n) + `)`)
		if err != nil {
			return result, err
		}
		cols := map[string]bool{}
		for rs.Next() {
			var cid, notnull, pk int
			var name, typ string
			var def any
			if err = rs.Scan(&cid, &name, &typ, &notnull, &def, &pk); err != nil {
				rs.Close()
				return result, err
			}
			cols[name] = true
		}
		err = rs.Err()
		rs.Close()
		if err != nil {
			return result, err
		}
		result.tables[n] = cols
	}
	return result, nil
}
func quote(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

// errUnsupportedNative marks a native database layout cxx does not know. It is
// a deliberate fail-closed skip (nothing is deleted), not a maintenance fault.
var errUnsupportedNative = errors.New("unsupported native database")

func (d database) require(table string, cols ...string) error {
	if d.tables[table] == nil {
		return fmt.Errorf("%w schema: %s/%s: missing table", errUnsupportedNative, filepath.Base(d.path), table)
	}
	var missing []string
	for _, c := range cols {
		if !d.tables[table][c] {
			missing = append(missing, c)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("%w schema: %s/%s: missing %s", errUnsupportedNative, filepath.Base(d.path), table, strings.Join(missing, ","))
	}
	return nil
}

var codexSupportedDatabases = map[string]bool{"state_5.sqlite": true, "thread_history_1.sqlite": true, "goals_1.sqlite": true, "queue_1.sqlite": true, "logs_2.sqlite": true, "memories_1.sqlite": true, "memories_v2_1.sqlite": true}
var versionedDatabase = regexp.MustCompile(`^([a-z][a-z_]*?)_([0-9]+)\.sqlite$`)

// supersededDatabase reports whether name is an older version of a supported
// family whose newer supported file sits beside it (e.g. logs_1 next to
// logs_2). Codex leaves such files behind after migrating; it no longer reads
// them, so they carry no protection data and are left untouched.
func supersededDatabase(name string, present map[string]bool) bool {
	m := versionedDatabase.FindStringSubmatch(name)
	if m == nil {
		return false
	}
	old, err := strconv.Atoi(m[2])
	if err != nil {
		return false
	}
	for other := range present {
		o := versionedDatabase.FindStringSubmatch(other)
		if o == nil || o[1] != m[1] || !codexSupportedDatabases[other] {
			continue
		}
		if v, err := strconv.Atoi(o[2]); err == nil && v > old {
			return true
		}
	}
	return false
}
func nativeDatabases(root, engine string) ([]database, error) {
	var paths []string
	if engine == "codex" {
		entries, err := os.ReadDir(root)
		if err != nil {
			return nil, err
		}
		present := map[string]bool{}
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".sqlite") {
				present[e.Name()] = true
			}
		}
		for _, e := range entries {
			n := e.Name()
			if !strings.HasSuffix(n, ".sqlite") {
				continue
			}
			if !codexSupportedDatabases[n] {
				if supersededDatabase(n, present) {
					continue
				}
				return nil, fmt.Errorf("%w version: %s", errUnsupportedNative, n)
			}
			paths = append(paths, filepath.Join(root, n))
		}
	} else if engine == "grok" {
		p := filepath.Join(root, "sessions/session_search.sqlite")
		if _, err := os.Lstat(p); err == nil {
			paths = append(paths, p)
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	var result []database
	for _, p := range paths {
		d, err := inspectDB(root, p)
		if err != nil {
			return nil, err
		}
		switch filepath.Base(p) {
		case "state_5.sqlite":
			err = d.require("threads", "id", "updated_at", "is_pinned")
		case "goals_1.sqlite":
			err = d.require("thread_goals", "thread_id", "status")
		case "queue_1.sqlite":
			err = d.require("queued_items", "thread_id")
		case "thread_history_1.sqlite":
			err = d.require("thread_items", "thread_id")
		case "logs_2.sqlite":
			err = d.require("logs", "thread_id")
		case "memories_1.sqlite", "memories_v2_1.sqlite":
			// Codex 0.165 memory v2 reuses the v1 stage1_outputs layout.
			err = d.require("stage1_outputs", "thread_id")
		case "session_search.sqlite":
			err = d.require("session_docs", "session_id", "title", "content")
			if err == nil {
				err = d.require("session_docs_fts", "title", "content")
			}
		}
		if err != nil {
			return nil, err
		}
		result = append(result, d)
	}
	return result, nil
}
func databaseProtection(dbs []database, sessions []session) ([]session, error) {
	byID := map[string]int{}
	for i, s := range sessions {
		byID[s.ID] = i
	}
	parents := map[string]string{}
	nativeProtected := map[string]bool{}
	for _, s := range sessions {
		if s.Parent != "" {
			parents[s.ID] = s.Parent
		}
	}
	for _, d := range dbs {
		db, err := openDB(d.path, false)
		if err != nil {
			return nil, err
		}
		query := func(q string, visit func(*sql.Rows) error) error {
			rs, e := db.Query(q)
			if e != nil {
				return e
			}
			defer rs.Close()
			for rs.Next() {
				if e = visit(rs); e != nil {
					return e
				}
			}
			return rs.Err()
		}
		switch filepath.Base(d.path) {
		case "state_5.sqlite":
			err = query(`SELECT id,updated_at,is_pinned FROM threads`, func(rs *sql.Rows) error {
				var id string
				var updated int64
				var pin int
				if e := rs.Scan(&id, &updated, &pin); e != nil {
					return e
				}
				if pin != 0 {
					nativeProtected[id] = true
				}
				if i, ok := byID[id]; ok {
					if pin != 0 {
						sessions[i].Protected = true
						sessions[i].Reason = "native_pin"
					}
					mt := time.Unix(updated, 0)
					if mt.After(sessions[i].Modified) {
						sessions[i].Modified = mt
					}
				}
				return nil
			})
			if err == nil && d.tables["thread_spawn_edges"] != nil {
				if err = d.require("thread_spawn_edges", "parent_thread_id", "child_thread_id"); err == nil {
					err = query(`SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges`, func(rs *sql.Rows) error {
						var p, c string
						if e := rs.Scan(&p, &c); e != nil {
							return e
						}
						parents[c] = p
						return nil
					})
				}
			}
		case "goals_1.sqlite":
			err = query(`SELECT thread_id FROM thread_goals WHERE status != 'complete'`, func(rs *sql.Rows) error {
				var id string
				if e := rs.Scan(&id); e != nil {
					return e
				}
				if i, ok := byID[id]; ok {
					sessions[i].Protected = true
					sessions[i].Reason = "open_goal"
				}
				return nil
			})
		case "queue_1.sqlite":
			err = query(`SELECT DISTINCT thread_id FROM queued_items`, func(rs *sql.Rows) error {
				var id string
				if e := rs.Scan(&id); e != nil {
					return e
				}
				if i, ok := byID[id]; ok {
					sessions[i].Protected = true
					sessions[i].Reason = "queued_native_work"
				}
				return nil
			})
		}
		db.Close()
		if err != nil {
			return nil, err
		}
	}
	// Connected parent/child components share recency, protection and deletion.
	groups := map[string]*session{}
	var order []string
	for _, s := range sessions {
		id := s.ID
		seen := map[string]bool{}
		for parents[id] != "" {
			if seen[id] {
				return nil, errors.New("cyclic native spawn graph")
			}
			seen[id] = true
			id = parents[id]
		}
		g := groups[id]
		if g == nil {
			g = &session{ID: id, Protected: nativeProtected[id]}
			groups[id] = g
			order = append(order, id)
		}
		g.IDs = append(g.IDs, s.IDs...)
		g.Files = append(g.Files, s.Files...)
		g.Bytes += s.Bytes
		if s.Modified.After(g.Modified) {
			g.Modified = s.Modified
		}
		if s.Protected {
			g.Protected = true
			g.Reason = s.Reason
		}
	}
	var result []session
	for _, id := range order {
		result = append(result, *groups[id])
	}
	return result, nil
}
func cleanDatabases(ctx context.Context, dbs []database, ids map[string]bool) error {
	for _, d := range dbs {
		db, err := openDB(d.path, true)
		if err != nil {
			return err
		}
		err = func() error {
			tx, e := db.BeginTx(ctx, nil)
			if e != nil {
				return e
			}
			defer tx.Rollback()
			if d.tables["session_docs"] != nil {
				// Match SQLite's external-content FTS contract; native triggers, if present,
				// own the index update. Otherwise emit the explicit delete command.
				var triggers int
				if e = tx.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='session_docs' AND lower(sql) LIKE '%delete%'`).Scan(&triggers); e != nil {
					return e
				}
				for id := range ids {
					if triggers == 0 {
						if _, e = tx.ExecContext(ctx, `INSERT INTO session_docs_fts(session_docs_fts,rowid,title,content) SELECT 'delete',rowid,title,content FROM session_docs WHERE session_id=?`, id); e != nil {
							return e
						}
					}
					if _, e = tx.ExecContext(ctx, `DELETE FROM session_docs WHERE session_id=?`, id); e != nil {
						return e
					}
				}
			} else {
				for table, cols := range d.tables {
					if cols["thread_id"] {
						for id := range ids {
							if _, e = tx.ExecContext(ctx, `DELETE FROM `+quote(table)+` WHERE thread_id=?`, id); e != nil {
								return e
							}
						}
					}
				}
				if d.tables["thread_spawn_edges"] != nil {
					for id := range ids {
						if _, e = tx.ExecContext(ctx, `DELETE FROM thread_spawn_edges WHERE parent_thread_id=? OR child_thread_id=?`, id, id); e != nil {
							return e
						}
					}
				}
				if d.tables["threads"] != nil {
					for id := range ids {
						if _, e = tx.ExecContext(ctx, `DELETE FROM threads WHERE id=?`, id); e != nil {
							return e
						}
					}
				}
			}
			return tx.Commit()
		}()
		if err == nil {
			_, err = db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`)
		}
		if err == nil {
			_, err = db.ExecContext(ctx, `VACUUM`)
		}
		db.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
func cleanJSONIndexes(root, engine string, ids map[string]bool) error {
	switch engine {
	case "codex":
		for _, x := range []struct{ p, k string }{{"session_index.jsonl", "id"}, {"history.jsonl", "session_id"}} {
			if err := rewriteJSONL(root, filepath.Join(root, x.p), ids, x.k); err != nil {
				return err
			}
		}
		// Known desktop references are pruned recursively; other UI state survives.
		for _, name := range []string{".codex-global-state.json", ".codex-global-state.json.bak"} {
			p := filepath.Join(root, name)
			if _, err := os.Lstat(p); os.IsNotExist(err) {
				continue
			}
			if err := safePath(root, p); err != nil {
				return err
			}
			raw, err := os.ReadFile(p)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return err
			}
			var v map[string]any
			if err = json.Unmarshal(raw, &v); err != nil {
				return err
			}
			for _, key := range []string{"pinned-thread-ids", "archived-thread-ids", "projectless-thread-ids", "thread-projectless-output-directories", "thread-workspace-root-hints", "sidebar-project-thread-orders", "electron-thread-read-state-v1", "thread-project-assignments", "thread-titles"} {
				if x, ok := v[key]; ok {
					v[key] = pruneReferences(x, ids)
				}
			}
			raw, err = json.Marshal(v)
			if err != nil {
				return err
			}
			if err = atomicJSONBytes(p, raw); err != nil {
				return err
			}
		}
	case "claude":
		if err := rewriteJSONL(root, filepath.Join(root, "history.jsonl"), ids, "sessionId"); err != nil {
			return err
		}
		paths, err := filepath.Glob(filepath.Join(root, "projects", "*", "sessions-index.json"))
		if err != nil {
			return err
		}
		for _, p := range paths {
			if err = safePath(root, p); err != nil {
				return err
			}
			raw, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			var v map[string]json.RawMessage
			if err = json.Unmarshal(raw, &v); err != nil {
				return err
			}
			var entries []map[string]json.RawMessage
			if err = json.Unmarshal(v["entries"], &entries); err != nil {
				return err
			}
			kept := entries[:0]
			for _, e := range entries {
				var id string
				_ = json.Unmarshal(e["sessionId"], &id)
				if !ids[id] {
					kept = append(kept, e)
				}
			}
			v["entries"], _ = json.Marshal(kept)
			raw, _ = json.Marshal(v)
			if err = atomicJSONBytes(p, raw); err != nil {
				return err
			}
		}
	case "grok":
		paths, _ := filepath.Glob(filepath.Join(root, "sessions", "*", "prompt_history.jsonl"))
		for _, p := range paths {
			if err := rewriteJSONL(root, p, ids, "session_id"); err != nil {
				return err
			}
		}
	}
	return nil
}
func pruneReferences(v any, ids map[string]bool) any {
	switch x := v.(type) {
	case map[string]any:
		for k, item := range x {
			if ids[k] {
				delete(x, k)
			} else {
				x[k] = pruneReferences(item, ids)
			}
		}
		return x
	case []any:
		kept := x[:0]
		for _, item := range x {
			if id, ok := item.(string); !ok || !ids[id] {
				kept = append(kept, pruneReferences(item, ids))
			}
		}
		return kept
	}
	return v
}
