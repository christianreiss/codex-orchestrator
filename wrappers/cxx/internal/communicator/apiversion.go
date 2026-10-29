package communicator

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

// APIVersion is the communicator/wrapper protocol level this binary speaks. It
// is an integer independent of the cxx release number and is raised only when
// the wire contract between cxx and the orchestrator changes incompatibly.
const APIVersion = 1

// APIHeader carries APIVersion on every request this binary sends to the
// orchestrator. Old servers ignore unknown headers.
const APIHeader = "X-Cxx-Api"

// SetAPIHeader stamps this binary's protocol level on an outgoing request.
func SetAPIHeader(h http.Header) {
	if h != nil {
		h.Set(APIHeader, strconv.Itoa(APIVersion))
	}
}

// API states reported in `communicator status` under `api.state`.
const (
	// APIStateUnknown: the server declared no level (an older server); the
	// floor is fail-open and nothing happens.
	APIStateUnknown = "unknown"
	// APIStateCurrent: this binary speaks the server's current level or newer.
	APIStateCurrent = "current"
	// APIStateUpdateQueued: at or above the minimum but below current; the
	// ordinary update runs once no agent is online.
	APIStateUpdateQueued = "update_queued"
	// APIStateUpdateRequired: below the minimum; the update runs immediately.
	APIStateUpdateRequired = "update_required"
	// APIStateBackoff: below the minimum and the last immediate attempt did not
	// raise the level (no published binary speaks it, or the attempt failed).
	APIStateBackoff = "backoff"
)

// maxAPILevel bounds what a server may declare; anything larger is treated as
// malformed rather than as a demand no binary can ever meet.
const maxAPILevel = 1 << 20

// APILevels is what a server declared: its current level and the effective
// minimum. Zero means the field was absent or malformed.
type APILevels struct {
	Server int `json:"api_version,omitempty"`
	Min    int `json:"min_api,omitempty"`
}

// Declared reports whether the server said anything usable.
func (l APILevels) Declared() bool { return l.Server > 0 || l.Min > 0 }

// ParseAPILevel reads one declared level tolerantly: only a JSON integer in
// (0, maxAPILevel] counts; strings, fractions, negatives, null and garbage
// read as absent. It never fails.
func ParseAPILevel(raw json.RawMessage) int {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] == '"' {
		return 0
	}
	var n json.Number
	if json.Unmarshal(raw, &n) != nil {
		return 0
	}
	v, err := strconv.ParseInt(n.String(), 10, 64)
	if err != nil || v <= 0 || v > maxAPILevel {
		return 0
	}
	return int(v)
}

// ParseAPILevels reads the top-level `api_version` and `min_api` of a JSON
// object (/versions, /wrapper/v2/meta, a control frame). When neither is at the
// top level, the standard envelope's `data` mirror is consulted. A body that
// is not an object yields no levels.
func ParseAPILevels(body []byte) APILevels {
	var top map[string]json.RawMessage
	if json.Unmarshal(body, &top) != nil {
		return APILevels{}
	}
	levels := APILevels{Server: ParseAPILevel(top["api_version"]), Min: ParseAPILevel(top["min_api"])}
	if !levels.Declared() && len(top["data"]) > 0 {
		var data map[string]json.RawMessage
		if json.Unmarshal(top["data"], &data) == nil {
			levels = APILevels{Server: ParseAPILevel(data["api_version"]), Min: ParseAPILevel(data["min_api"])}
		}
	}
	return levels
}

// APINote summarizes a declaration for an engine doctor's API row; empty
// when the server declared nothing.
func APINote(l APILevels) string {
	if !l.Declared() {
		return ""
	}
	note := "cxx API " + strconv.Itoa(APIVersion)
	if l.Server > 0 {
		note += ", server " + strconv.Itoa(l.Server)
	}
	if l.Min > 0 {
		note += ", min " + strconv.Itoa(l.Min)
	}
	switch APIPolicy(APIVersion, l) {
	case APIStateUpdateRequired:
		note += ": below the minimum, the communicator updates immediately"
	case APIStateUpdateQueued:
		note += ": update queued until no agents are online"
	}
	return note
}

// APIPolicy maps this binary's level against the server's declaration:
// below the minimum is required (immediate), below current is queued (when no
// agent is online), otherwise nothing. Absent fields fail open.
func APIPolicy(client int, l APILevels) string {
	switch {
	case !l.Declared():
		return APIStateUnknown
	case l.Min > 0 && client < l.Min:
		return APIStateUpdateRequired
	case l.Server > 0 && client < l.Server:
		return APIStateUpdateQueued
	default:
		return APIStateCurrent
	}
}

// APIStatus is the `api` block of `communicator status`.
type APIStatus struct {
	Version       int    `json:"version"`
	ServerVersion int    `json:"server_version,omitempty"`
	MinAPI        int    `json:"min_api,omitempty"`
	State         string `json:"state"`
	NextAttempt   string `json:"next_attempt,omitempty"`
	Reason        string `json:"reason,omitempty"`
	Remedy        string `json:"remedy,omitempty"`
}

// APIBackoff is the updater's record that an immediate (below-minimum)
// attempt could not raise this binary's level. A zero Until clears it.
type APIBackoff struct {
	Until  time.Time
	Reason string
}

// apiView composes the status block from the declared levels and the
// updater's backoff.
func apiView(levels APILevels, backoff APIBackoff) APIStatus {
	st := APIStatus{Version: APIVersion, ServerVersion: levels.Server, MinAPI: levels.Min, State: APIPolicy(APIVersion, levels)}
	if st.State == APIStateUpdateRequired && !backoff.Until.IsZero() {
		st.State = APIStateBackoff
		st.NextAttempt = backoff.Until.UTC().Format(time.RFC3339)
		st.Reason = backoff.Reason
		st.Remedy = apiRemedy(levels.Min)
	}
	return st
}

func apiRemedy(min int) string {
	return "the orchestrator requires cxx API level " + strconv.Itoa(min) + " but this cxx speaks " + strconv.Itoa(APIVersion) +
		" and no newer published cxx is offered to this host; publish a cxx release with that API level (or lower the server's minimum), check auto-update and fleet locks for this host, then run 'cxx update'"
}

// observeAPI records a server declaration. authoritative (the handshake's
// ready frame) replaces the levels even when absent, so a rolled-back server
// clears a stale minimum; later periodic frames only refine a declaration.
func (s *server) observeAPI(levels APILevels, authoritative bool) {
	if !authoritative && !levels.Declared() {
		return
	}
	s.mu.Lock()
	changed := s.apiLevels != levels
	s.apiLevels = levels
	s.mu.Unlock()
	s.apiHello.Store(levels.Server > 0)
	if changed {
		s.triggerUpdate()
	}
}

func (s *server) apiSnapshot() APILevels {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.apiLevels
}
