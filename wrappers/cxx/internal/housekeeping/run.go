// Package housekeeping removes only idle, unprotected native session bundles.
package housekeeping

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionguard"
	"github.com/google/uuid"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Policy struct {
	Enabled       bool   `json:"enabled"`
	RetentionDays int    `json:"retention_days"`
	MaxBytes      int64  `json:"max_bytes"`
	MinAgeDays    int    `json:"min_age_days"`
	Source        string `json:"source,omitempty"`
}

func (p Policy) validate() error {
	if p.RetentionDays < 1 || p.RetentionDays > 3650 || p.MinAgeDays < 1 || p.MinAgeDays > p.RetentionDays || p.MaxBytes < 1<<20 || p.MaxBytes > 1<<40 {
		return errors.New("invalid housekeeping policy")
	}
	return nil
}

type Protection struct {
	Policy Policy   `json:"policy"`
	IDs    []string `json:"protected_ids"`
}
type Server interface {
	Inspect(context.Context) (Protection, error)
	Reserve(context.Context, string) (Protection, error)
	Release(context.Context, string) error
	Report(context.Context, Result) error
}
type Result struct {
	Engine      string   `json:"engine"`
	Policy      Policy   `json:"policy"`
	BytesBefore int64    `json:"bytes_before"`
	BytesAfter  int64    `json:"bytes_after"`
	FreedBytes  int64    `json:"freed_bytes"`
	Deleted     int      `json:"deleted"`
	Protected   int      `json:"protected"`
	Candidates  int      `json:"candidates"`
	Outcome     string   `json:"outcome"`
	Reason      string   `json:"reason,omitempty"`
	IDs         []string `json:"candidate_ids,omitempty"`
}
type Options struct {
	Root, Engine      string
	DryRun, Automatic bool
	Server            Server
	Now               time.Time
	Busy              func(string) (bool, error)
}
type move struct {
	Original   string    `json:"original"`
	Quarantine string    `json:"quarantine"`
	Size       int64     `json:"size"`
	Modified   time.Time `json:"modified"`
}
type journal struct {
	Version int      `json:"version,omitempty"`
	Token   string   `json:"token"`
	Engine  string   `json:"engine"`
	Moves   []move   `json:"moves"`
	IDs     []string `json:"ids"`
	Phase   string   `json:"phase"`
	Bytes   int64    `json:"bytes"`
	Count   int      `json:"count"`
}

func atomicJSONBytes(path string, raw []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".housekeeping-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err = f.Chmod(0600); err != nil {
		return err
	}
	if _, err = f.Write(raw); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func writeJSON(path string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return atomicJSONBytes(path, raw)
}
func loadPins(root string) (map[string]bool, error) {
	pins := map[string]bool{}
	raw, err := os.ReadFile(filepath.Join(root, ".cxx-housekeeping/pins.json"))
	if os.IsNotExist(err) {
		return pins, nil
	}
	if err != nil {
		return nil, err
	}
	err = json.Unmarshal(raw, &pins)
	return pins, err
}
func protect(root string, sessions []session, remote []string) ([]session, error) {
	pins, err := loadPins(root)
	if err != nil {
		return nil, err
	}
	for _, id := range remote {
		pins[id] = true
	}
	for _, name := range []string{".codex-global-state.json", ".codex-global-state.json.bak"} {
		raw, err := os.ReadFile(filepath.Join(root, name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		var obj map[string]json.RawMessage
		if err = json.Unmarshal(raw, &obj); err != nil {
			return nil, err
		}
		if val := obj["pinned-thread-ids"]; val != nil {
			var ids []string
			if err = json.Unmarshal(val, &ids); err != nil {
				return nil, err
			}
			for _, id := range ids {
				pins[id] = true
			}
		}
	}
	for i := range sessions {
		if pins[sessions[i].ID] || pins[sessions[i].Parent] {
			sessions[i].Protected = true
			sessions[i].Reason = "pinned_or_fleet_bound"
		}
	}
	return sessions, nil
}
func Run(ctx context.Context, o Options) (r Result, err error) {
	r.Engine = o.Engine
	r.Outcome = "failed"
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	if o.Busy == nil {
		o.Busy = nativeBusy
	}
	if _, e := os.Lstat(o.Root); os.IsNotExist(e) {
		r.Outcome = "absent"
		return r, nil
	}
	var lock *ipc.Lock
	var e error
	if o.DryRun {
		lock, e = ipc.TryAcquireSharedPath(filepath.Join(o.Root, ".cxx-housekeeping.lock"))
	} else {
		lock, e = sessionguard.Maintenance(o.Root)
	}
	if e != nil {
		r.Outcome = "skipped"
		r.Reason = "active_launch_or_maintenance"
		return r, nil
	}
	defer lock.Release()
	if e = ensureRealDir(o.Root, filepath.Join(o.Root, ".cxx-housekeeping")); e != nil {
		return r, e
	}
	pinsLock, e := ipc.TryAcquireExclusivePath(filepath.Join(o.Root, ".cxx-housekeeping/pins.lock"))
	if e != nil {
		return r, e
	}
	defer pinsLock.Release()
	if o.Engine == "grok" && !o.DryRun {
		nativeLock, e := ipc.TryAcquireExclusivePath(filepath.Join(o.Root, ".cgx-sessions.lock"))
		if e != nil {
			r.Outcome = "skipped"
			r.Reason = "active_native_runtime"
			return r, nil
		}
		defer nativeLock.Release()
	}
	journalPath := filepath.Join(o.Root, ".cxx-housekeeping/journal.json")
	raw, jerr := os.ReadFile(journalPath)
	if jerr != nil && !os.IsNotExist(jerr) {
		return r, jerr
	}
	if o.Automatic && os.IsNotExist(jerr) {
		var state struct {
			LastRun time.Time `json:"last_run"`
		}
		b, _ := os.ReadFile(filepath.Join(o.Root, ".cxx-housekeeping/state.json"))
		_ = json.Unmarshal(b, &state)
		if o.Now.Sub(state.LastRun) < 24*time.Hour {
			r.Outcome = "not_due"
			return r, nil
		}
	}
	p, e := o.Server.Inspect(ctx)
	if e != nil {
		r.Outcome = "skipped"
		r.Reason = "protection_unavailable"
		return r, e
	}
	r.Policy = p.Policy
	if e = p.Policy.validate(); e != nil {
		return r, e
	}
	dbs, e := nativeDatabases(o.Root, o.Engine)
	if e != nil {
		r.Outcome = "skipped"
		r.Reason = "unsupported_or_locked_native_database"
		return r, e
	}
	if e = preflightIndexes(o.Root, o.Engine); e != nil {
		r.Outcome = "skipped"
		r.Reason = "unsupported_native_index"
		return r, e
	}
	if jerr == nil {
		r.Outcome = "recovery_required"
		if o.DryRun {
			r.Reason = "run housekeeping without --dry-run to recover journal"
			return r, nil
		}
		var j journal
		if e = json.Unmarshal(raw, &j); e != nil {
			return r, e
		}
		if j.Engine != o.Engine || !uuidRE.MatchString(j.Token) {
			return r, errors.New("invalid housekeeping journal")
		}
		busy, e := o.Busy(o.Engine)
		if e != nil || busy {
			r.Reason = "native_process_active"
			return r, e
		}
		if _, e = o.Server.Reserve(ctx, j.Token); e != nil {
			return r, e
		}
		if e = completeJournal(ctx, o.Root, journalPath, &j, dbs, o.Server, o.Busy); e != nil {
			if errors.Is(e, errSelectionChanged) {
				r.Outcome, r.Reason = "rolled_back", e.Error()
				return r, nil
			}
			return r, e
		}
		r.FreedBytes = j.Bytes
		r.Deleted = j.Count
		r.Outcome = "recovered"
		return r, nil
	}
	sessions, e := scan(o.Root, o.Engine)
	if e != nil {
		return r, e
	}
	sessions, e = protect(o.Root, sessions, p.IDs)
	if e != nil {
		return r, e
	}
	sessions, e = databaseProtection(dbs, sessions)
	if e != nil {
		return r, e
	}
	sessions, e = protect(o.Root, sessions, p.IDs)
	if e != nil {
		return r, e
	}
	chosen, total, n := selectSessions(sessions, p.Policy, o.Now)
	r.BytesBefore = total
	r.BytesAfter = total
	r.Protected = n
	r.Candidates = len(chosen)
	for _, s := range chosen {
		r.IDs = append(r.IDs, s.IDs...)
	}
	busy, e := o.Busy(o.Engine)
	if e != nil {
		return r, e
	}
	if o.DryRun {
		r.Outcome = "dry_run"
		if busy {
			r.Reason = "native_process_active; deletion deferred"
		}
		return r, nil
	}
	if !p.Policy.Enabled {
		r.Outcome = "disabled"
		return r, nil
	}
	if busy {
		r.Outcome = "skipped"
		r.Reason = "native_process_active"
		return r, nil
	}
	if len(chosen) > 0 {
		j := journal{Version: 2, Token: uuid.NewString(), Engine: o.Engine, Phase: "prepared"}
		if e = writeJSON(journalPath, j); e != nil {
			return r, e
		}
		// Persist the token before the server call: even an ambiguous HTTP response
		// can be recovered using the same durable reservation.
		p, e = o.Server.Reserve(ctx, j.Token)
		if e != nil {
			return r, e
		}
		if e = p.Policy.validate(); e != nil {
			return r, e
		}
		if busy, e = o.Busy(o.Engine); e != nil || busy {
			// No local artifact has moved. Release this reservation without
			// leaving a journal that would block a legitimate native launch.
			releaseErr := completeJournal(ctx, o.Root, journalPath, &j, dbs, o.Server)
			r.Outcome, r.Reason = "skipped", "native_process_active"
			return r, errors.Join(e, releaseErr)
		}
		sessions, e = scan(o.Root, o.Engine)
		if e != nil {
			return r, e
		}
		sessions, e = protect(o.Root, sessions, p.IDs)
		if e != nil {
			return r, e
		}
		sessions, e = databaseProtection(dbs, sessions)
		if e != nil {
			return r, e
		}
		sessions, e = protect(o.Root, sessions, p.IDs)
		if e != nil {
			return r, e
		}
		chosen, _, _ = selectSessions(sessions, p.Policy, o.Now)
		if !p.Policy.Enabled {
			chosen = nil
		}
		for _, s := range chosen {
			j.IDs = append(j.IDs, s.IDs...)
			j.Bytes += s.Bytes
			j.Count++
			for _, f := range s.Files {
				rel, _ := filepath.Rel(o.Root, f.Path)
				j.Moves = append(j.Moves, move{f.Path, filepath.Join(o.Root, ".cxx-housekeeping/quarantine", j.Token, rel), f.Size, f.Modified})
			}
		}
		j.Phase = "moving"
		if e = writeJSON(journalPath, j); e != nil {
			return r, e
		}
		if e = completeJournal(ctx, o.Root, journalPath, &j, dbs, o.Server, o.Busy); e != nil {
			if errors.Is(e, errSelectionChanged) {
				r.Outcome, r.Reason = "rolled_back", e.Error()
				return r, nil
			}
			return r, e
		}
		r.FreedBytes = j.Bytes
		r.Deleted = j.Count
		r.BytesAfter = total - j.Bytes
	}
	r.Outcome = "completed"
	if r.BytesAfter > p.Policy.MaxBytes {
		r.Reason = "budget exceeded by protected or young sessions"
	}
	if e = writeJSON(filepath.Join(o.Root, ".cxx-housekeeping/state.json"), map[string]any{"last_run": o.Now, "result": r}); e != nil {
		return r, e
	}
	err = o.Server.Report(ctx, r)
	return r, err
}
func completeJournal(ctx context.Context, root, path string, j *journal, dbs []database, server Server, busyChecks ...func(string) (bool, error)) error {
	checkIdle := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		for _, check := range busyChecks {
			busy, err := check(j.Engine)
			if err != nil {
				return err
			}
			if busy {
				return errors.New("native process became active; housekeeping deferred")
			}
		}
		return nil
	}
	if j.Phase == "prepared" {
		if err := server.Release(ctx, j.Token); err != nil {
			return err
		}
		return os.Remove(path)
	}
	if err := checkIdle(); err != nil {
		return err
	}
	if j.Phase == "rolling_back" {
		return rollbackJournal(ctx, root, path, j, server, checkIdle)
	}
	if j.Phase != "moving" && j.Phase != "indexing" && j.Phase != "purging" {
		return errors.New("invalid housekeeping journal phase")
	}
	if j.Phase == "moving" {
		changed, rollbackSafe, err := checkMovingSnapshot(root, j)
		if err != nil {
			return err
		}
		if changed {
			if !rollbackSafe {
				return errors.New("legacy housekeeping journal may have modified indexes; manual recovery required")
			}
			return rollbackJournal(ctx, root, path, j, server, checkIdle)
		}
	}
	ids := map[string]bool{}
	for _, id := range j.IDs {
		if !uuidRE.MatchString(id) {
			return errors.New("invalid journal session id")
		}
		ids[id] = true
	}
	for _, m := range j.Moves {
		if err := checkIdle(); err != nil {
			return err
		}
		if err := validateMove(root, j.Token, m); err != nil {
			return err
		}
		st, err := os.Lstat(m.Original)
		if os.IsNotExist(err) {
			if _, e := os.Lstat(m.Quarantine); e == nil || j.Phase == "purging" {
				continue
			}
			return errors.New("journal artifact missing from both locations")
		}
		if err != nil {
			return err
		}
		if j.Phase == "purging" || j.Phase == "indexing" {
			return errors.New("native artifact reappeared during housekeeping")
		}
		if err = safePath(root, m.Original); err != nil {
			return err
		}
		if !st.Mode().IsRegular() || st.Size() != m.Size || !st.ModTime().Equal(m.Modified) {
			return rollbackJournal(ctx, root, path, j, server, checkIdle)
		}
		if err = ensureRealDir(root, filepath.Dir(m.Quarantine)); err != nil {
			return err
		}
		if _, err = os.Lstat(m.Quarantine); !os.IsNotExist(err) {
			return errors.New("quarantine target already exists")
		}
		if err = os.Rename(m.Original, m.Quarantine); err != nil {
			return err
		}
	}
	if j.Phase != "purging" {
		// A durable boundary prevents recovery from restoring files after
		// their database/index entries have already been removed.
		j.Phase = "indexing"
		if err := writeJSON(path, j); err != nil {
			return err
		}
		if err := checkIdle(); err != nil {
			return err
		}
		if err := cleanDatabases(ctx, dbs, ids); err != nil {
			return err
		}
		if err := cleanJSONIndexes(root, j.Engine, ids); err != nil {
			return err
		}
		j.Phase = "purging"
		if err := writeJSON(path, j); err != nil {
			return err
		}
	}
	for _, m := range j.Moves {
		if err := checkIdle(); err != nil {
			return err
		}
		if err := safePath(root, m.Quarantine); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := os.Remove(m.Quarantine); err != nil && !os.IsNotExist(err) {
			return err
		}
		removeEmptyParents(root, filepath.Dir(m.Original))
		removeEmptyParents(root, filepath.Dir(m.Quarantine))
	}
	// The local exclusive guard stays held through remote release and journal
	// removal. Managed launches cannot observe a partially cleaned native home.
	if err := server.Release(ctx, j.Token); err != nil {
		return err
	}
	return os.Remove(path)
}
func validateMove(root, token string, m move) error {
	rel, err := filepath.Rel(root, m.Original)
	if err != nil || rel == "." || rel == ".." || len(rel) > 3 && rel[:3] == "../" {
		return errors.New("invalid journal original path")
	}
	expected := filepath.Join(root, ".cxx-housekeeping/quarantine", token, rel)
	if expected != m.Quarantine {
		return errors.New("invalid journal quarantine path")
	}
	return nil
}
func removeEmptyParents(root, dir string) {
	for dir != root && dir != filepath.Dir(root) {
		if err := os.Remove(dir); err != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}
func Pin(root, id string, enabled bool) error {
	if !uuidRE.MatchString(id) {
		return fmt.Errorf("invalid native session UUID")
	}
	if err := ensureRealDir(root, filepath.Join(root, ".cxx-housekeeping")); err != nil {
		return err
	}
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(root, ".cxx-housekeeping/pins.lock"))
	if err != nil {
		return err
	}
	defer lock.Release()
	if _, err = os.Stat(filepath.Join(root, ".cxx-housekeeping/journal.json")); !os.IsNotExist(err) {
		return errors.New("housekeeping journal requires recovery")
	}
	pins, err := loadPins(root)
	if err != nil {
		return err
	}
	if enabled {
		pins[id] = true
	} else {
		delete(pins, id)
	}
	return writeJSON(filepath.Join(root, ".cxx-housekeeping/pins.json"), pins)
}

func ensureRealDir(root, dir string) error {
	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return errors.New("housekeeping directory outside native home")
	}
	cur := root
	for _, part := range strings.Split(rel, string(os.PathSeparator)) {
		if part == "." {
			continue
		}
		cur = filepath.Join(cur, part)
		if err = os.Mkdir(cur, 0700); err != nil && !os.IsExist(err) {
			return err
		}
		st, err := os.Lstat(cur)
		if err != nil {
			return err
		}
		if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return errors.New("housekeeping directory is a symlink or non-directory")
		}
	}
	return nil
}
