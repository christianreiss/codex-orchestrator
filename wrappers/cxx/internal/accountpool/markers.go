package accountpool

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// Session markers let a second wrapper process (`clx accounts use`) find a
// live lease of the same scope. One file per lease next to the binding file;
// they hold identifiers only and are removed on release. Stale markers of
// processes that died are pruned by LiveSessions.
type sessionMarker struct {
	SessionID string    `json:"session_id"`
	PID       int       `json:"pid"`
	StartedAt time.Time `json:"started_at"`
}

func (c *Context) markerDir() string {
	return strings.TrimSuffix(c.path, ".json") + ".sessions"
}

func validSessionID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, r := range id {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F' || r == '-') {
			return false
		}
	}
	return true
}

// writeSessionMarker is best effort: a missing marker only means
// `clx accounts use` cannot reach this session.
func (c *Context) writeSessionMarker(id string) func() {
	if !validSessionID(id) {
		return func() {}
	}
	dir := c.markerDir()
	if os.MkdirAll(dir, 0o700) != nil {
		return func() {}
	}
	path := filepath.Join(dir, id+".json")
	raw, _ := json.Marshal(sessionMarker{SessionID: id, PID: os.Getpid(), StartedAt: time.Now().UTC()})
	if os.WriteFile(path, raw, 0o600) != nil {
		return func() {}
	}
	return func() { _ = os.Remove(path) }
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// LiveSessions returns the lease IDs of live wrapper processes in this scope,
// newest first.
func (c *Context) LiveSessions() []string {
	if c == nil {
		return nil
	}
	entries, err := os.ReadDir(c.markerDir())
	if err != nil {
		return nil
	}
	var live []sessionMarker
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(c.markerDir(), entry.Name())
		raw, err := os.ReadFile(path)
		var m sessionMarker
		if err != nil || json.Unmarshal(raw, &m) != nil || !validSessionID(m.SessionID) || m.SessionID+".json" != entry.Name() {
			continue
		}
		if !processAlive(m.PID) {
			_ = os.Remove(path)
			continue
		}
		live = append(live, m)
	}
	sort.Slice(live, func(i, j int) bool { return live[i].StartedAt.After(live[j].StartedAt) })
	ids := make([]string, 0, len(live))
	for _, m := range live {
		ids = append(ids, m.SessionID)
	}
	return ids
}
