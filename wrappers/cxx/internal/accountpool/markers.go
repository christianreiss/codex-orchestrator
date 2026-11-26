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
	// Turn is the holder's own hook evidence about its root Claude turn:
	// "busy", "idle", or empty when it has none (a launch without the
	// receiver hooks, or a wrapper that does not publish it).
	Turn string `json:"turn,omitempty"`
	// TurnAt is the last hook that confirmed Turn.
	TurnAt time.Time `json:"turn_at,omitempty"`
}

const (
	turnBusy = "busy"
	turnIdle = "idle"
	// A running turn fires hooks; each one confirms the marker, at most
	// every turnConfirmEvery. A turn the user interrupted fires no Stop, so
	// a busy marker nothing confirmed for busyTurnFresh is no evidence any
	// more and the sibling is unknown again.
	turnConfirmEvery = 30 * time.Second
	busyTurnFresh    = 15 * time.Minute
)

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

// SetSessionTurn publishes this launch's hook evidence in its session marker,
// so a sibling about to switch the scope's account sees a running turn. It is
// called from the hook path and stays local: one small file, replaced whole.
func (c *Context) SetSessionTurn(idle, known bool) {
	if c == nil {
		return
	}
	c.mu.Lock()
	id := c.SessionID
	c.mu.Unlock()
	if !validSessionID(id) {
		return
	}
	path := filepath.Join(c.markerDir(), id+".json")
	raw, err := os.ReadFile(path)
	var m sessionMarker
	if err != nil || json.Unmarshal(raw, &m) != nil || m.SessionID != id {
		return
	}
	turn := ""
	if known {
		turn = turnBusy
		if idle {
			turn = turnIdle
		}
	}
	now := time.Now().UTC()
	if m.Turn == turn && now.Sub(m.TurnAt) < turnConfirmEvery {
		return
	}
	m.Turn, m.TurnAt = turn, now
	next, _ := json.Marshal(m)
	tmp := path + ".tmp"
	if os.WriteFile(tmp, next, 0o600) != nil {
		return
	}
	if os.Rename(tmp, path) != nil {
		_ = os.Remove(tmp)
	}
}

// SiblingTurns reads what the other live launches of this scope publish:
// busy when one of them reports a running turn, unknown when one of them
// publishes nothing. Unknown is never idle; the caller falls back to what it
// can observe itself.
func (c *Context) SiblingTurns() (busy, unknown bool) {
	if c == nil {
		return false, false
	}
	c.mu.Lock()
	own := c.SessionID
	c.mu.Unlock()
	for _, m := range c.liveMarkers() {
		if m.SessionID == own {
			continue
		}
		switch {
		case m.Turn == turnBusy && time.Since(m.TurnAt) <= busyTurnFresh:
			busy = true
		case m.Turn == turnIdle:
		default:
			unknown = true
		}
	}
	return busy, unknown
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
	live := c.liveMarkers()
	ids := make([]string, 0, len(live))
	for _, m := range live {
		ids = append(ids, m.SessionID)
	}
	return ids
}

func (c *Context) liveMarkers() []sessionMarker {
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
	return live
}
