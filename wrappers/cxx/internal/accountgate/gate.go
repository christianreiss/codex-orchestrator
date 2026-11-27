// Package accountgate holds one Claude session at its hooks while the server
// switches the scope's provider account (pause, switch, resume).
//
// A Claude Code session cannot be stopped from outside, but it runs a hook
// before every model request of its agent loop: UserPromptSubmit before the
// first one of a turn, PostToolBatch before each later one, SubagentStart
// before a subagent's first one, and Stop before a continuation that a Stop
// hook asks for. Claude Code waits for a hook up to its timeout and then
// proceeds as if it had not run, so a hold that outlives its budget fails
// open. (Measured against Claude Code 2.1.332; docs/interface-clx.md.)
//
// Everything is files in one directory per provider lease, because the hook
// is a short process with no connection of its own and must cost nothing
// while no pause is active:
//
//	pause.json   the active pause: round, local deadline, owning wrapper
//	ready        a hook of this launch has run (proof that the session is gated)
//	t-*.json     one phase file per thread (the root loop or a subagent)
//	c-*          a Stop was answered with "block": the turn continues
//
// The wrapper that holds the lease writes pause.json and reads the phases;
// the hooks write the phases and wait while pause.json is valid.
package accountgate

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/posix"
)

// EnvDir names the gate directory of the launch for its hook processes.
const EnvDir = "CXX_ACCOUNT_GATE_DIR"

// HookTimeoutSeconds is the hook timeout Claude Code is given. It has to stay
// above MaxHold: a hook that is cancelled can no longer record that its
// thread went on to a model request.
const HookTimeoutSeconds = 330

// MaxHold bounds one hold whatever the pause file says.
const MaxHold = 300 * time.Second

// Phases of one thread.
const (
	// PhaseModel: a model request may be in flight or about to be sent.
	PhaseModel = "model"
	// PhaseTool: the model answered and its tools run; the next model request
	// comes only after PostToolBatch.
	PhaseTool = "tool"
	// PhaseIdle: the turn ended.
	PhaseIdle = "idle"
	// PhaseHeld: a hook of the thread is waiting in the gate.
	PhaseHeld = "held"
)

// modelStale is how long a model phase that no hook has touched is believed.
// A turn the user interrupted fires no hook at all; without a limit one such
// session would keep every pause of its scope from completing.
const modelStale = 10 * time.Minute

const (
	pauseFile = "pause.json"
	readyFile = "ready"
	lockFile  = "lock"
)

var holdPoll = 100 * time.Millisecond

// Pause is the active pause of one session.
type Pause struct {
	Round string `json:"round"`
	// Deadline is local time: the latest moment a hook is still held.
	Deadline time.Time `json:"deadline"`
	// OwnerPID is the wrapper that wrote the file. Its hooks stop waiting
	// when it is gone, so a killed wrapper never leaves a session held.
	OwnerPID int `json:"owner_pid"`
}

// Thread is the last known phase of one thread.
type Thread struct {
	Phase      string    `json:"phase"`
	At         time.Time `json:"at"`
	Event      string    `json:"event,omitempty"`
	Session    string    `json:"session,omitempty"`
	Agent      string    `json:"agent,omitempty"`
	Transcript string    `json:"transcript,omitempty"`
}

// HookInput is the part of a Claude Code hook payload the gate reads.
type HookInput struct {
	Event          string `json:"hook_event_name"`
	SessionID      string `json:"session_id"`
	AgentID        string `json:"agent_id"`
	Source         string `json:"source"`
	TranscriptPath string `json:"transcript_path"`
}

// Dir is the gate directory of a lease below the scope's session marker
// directory.
func Dir(markerDir, leaseID string) string {
	return filepath.Join(markerDir, leaseID+".gate")
}

// Prepare creates an empty gate directory for a new launch.
func Prepare(dir string) error {
	if dir == "" {
		return errors.New("no gate directory")
	}
	_ = os.RemoveAll(dir)
	return os.MkdirAll(dir, 0o700)
}

// Remove deletes the gate directory when its launch ends.
func Remove(dir string) {
	if dir != "" {
		_ = os.RemoveAll(dir)
	}
}

func writeAtomic(path string, raw []byte) error {
	suffix := make([]byte, 6)
	if _, err := rand.Read(suffix); err != nil {
		return err
	}
	tmp := path + "." + hex.EncodeToString(suffix) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// Activate starts or extends a pause. A later call for the same round never
// moves its deadline further out: the budget counts from the first request.
func Activate(dir string, p Pause) error {
	if dir == "" || p.Round == "" {
		return errors.New("no gate directory or round")
	}
	if current, ok := read(dir); ok && current.Round == p.Round && current.Deadline.Before(p.Deadline) {
		p.Deadline = current.Deadline
	}
	if p.OwnerPID == 0 {
		p.OwnerPID = os.Getpid()
	}
	raw, _ := json.Marshal(p)
	return writeAtomic(filepath.Join(dir, pauseFile), raw)
}

// Release ends the pause; every hook waiting in the gate returns.
func Release(dir string) {
	if dir != "" {
		_ = os.Remove(filepath.Join(dir, pauseFile))
	}
}

func read(dir string) (Pause, bool) {
	raw, err := os.ReadFile(filepath.Join(dir, pauseFile))
	var p Pause
	if err != nil || json.Unmarshal(raw, &p) != nil || p.Round == "" {
		return Pause{}, false
	}
	return p, true
}

// Active returns the pause that holds hooks right now: the file exists, its
// deadline has not passed and its owner is alive.
func Active(dir string, now time.Time) (Pause, bool) {
	p, ok := read(dir)
	if !ok || !now.Before(p.Deadline) || !processAlive(p.OwnerPID) {
		return Pause{}, false
	}
	return p, true
}

// Ready reports that a hook of this launch has run, so the session is gated.
func Ready(dir string) bool {
	if dir == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, readyFile))
	return err == nil
}

func threadKey(session, agent string) string {
	sum := sha256.Sum256([]byte(session + "\x00" + agent))
	return hex.EncodeToString(sum[:12])
}

func threadPath(dir, session, agent string) string {
	return filepath.Join(dir, "t-"+threadKey(session, agent)+".json")
}

func continuePath(dir, session, agent string) string {
	return filepath.Join(dir, "c-"+threadKey(session, agent))
}

func setPhase(dir string, in HookInput, phase string, now time.Time) {
	raw, _ := json.Marshal(Thread{Phase: phase, At: now.UTC(), Event: in.Event, Session: in.SessionID, Agent: in.AgentID, Transcript: in.TranscriptPath})
	_ = writeAtomic(threadPath(dir, in.SessionID, in.AgentID), raw)
}

func readThread(path string) (Thread, bool) {
	raw, err := os.ReadFile(path)
	var t Thread
	if err != nil || json.Unmarshal(raw, &t) != nil || t.Phase == "" {
		return Thread{}, false
	}
	return t, true
}

// locked runs fn with the directory's lock held. The lock orders the two
// writers of a Stop: the gate hook and the hook that may block the Stop.
func locked(dir string, fn func()) {
	f, err := os.OpenFile(filepath.Join(dir, lockFile), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		fn()
		return
	}
	defer f.Close()
	if posix.Flock(int(f.Fd()), posix.LOCK_EX) == nil {
		defer posix.Flock(int(f.Fd()), posix.LOCK_UN)
	}
	fn()
}

// hold waits while a pause is active and reports how long it waited.
func hold(dir string, in HookInput, clock func() time.Time) time.Duration {
	started := clock()
	if _, ok := Active(dir, started); !ok {
		return 0
	}
	setPhase(dir, in, PhaseHeld, started)
	limit := started.Add(MaxHold)
	for {
		time.Sleep(holdPoll)
		now := clock()
		if _, ok := Active(dir, now); !ok || !now.Before(limit) {
			return now.Sub(started)
		}
	}
}

// Hook applies one hook event: it records the thread's phase and, before a
// model request, waits while a pause is active.
//
// The order inside a holding event matters, in both directions.
//
// Without a pause the phase is written as "model" before the gate is looked
// at a second time (in hold). A wrapper that activates a pause and then reads
// this thread either sees "model" and waits, or it read before that write, in
// which case its pause file was already there for the second look and the
// hook holds. So no thread is counted as paused while it walks on to a model
// request.
//
// With a pause already active the hook goes straight to "held" and never
// writes "model" first. A session that has reported itself paused has its
// tools finish one after another during the round; if each of them passed
// through "model" on its way into the gate, the wrapper would sooner or later
// read that instant and take its report back.
func Hook(dir string, in HookInput) time.Duration {
	return hook(dir, in, time.Now)
}

func hook(dir string, in HookInput, clock func() time.Time) time.Duration {
	if dir == "" || in.SessionID == "" {
		return 0
	}
	if _, err := os.Stat(dir); err != nil {
		return 0
	}
	if !Ready(dir) {
		_ = os.WriteFile(filepath.Join(dir, readyFile), []byte(clock().UTC().Format(time.RFC3339)+"\n"), 0o600)
	}
	var held time.Duration
	switch in.Event {
	case "SessionStart":
		// A resumed, cleared or freshly started session is between turns.
		// Other sources (compaction) keep what the thread was doing.
		if in.AgentID == "" && (in.Source == "startup" || in.Source == "resume" || in.Source == "clear") {
			setPhase(dir, in, PhaseIdle, clock())
		}
	case "UserPromptSubmit":
		_ = os.Remove(continuePath(dir, in.SessionID, in.AgentID))
		fallthrough
	case "PostToolBatch", "PreCompact", "SubagentStart":
		_, pausing := Active(dir, clock())
		if !pausing {
			setPhase(dir, in, PhaseModel, clock())
		}
		// Released, or the pause ended between the two looks: the thread
		// goes on to its model request either way, and says so.
		if held = hold(dir, in, clock); held > 0 || pausing {
			setPhase(dir, in, PhaseModel, clock())
		}
	case "PreToolUse":
		setPhase(dir, in, PhaseTool, clock())
	case "Stop":
		// A Stop hook may answer "block", and the turn then goes on without
		// a prompt hook. The Stop is held like a prompt, and whoever blocks
		// it leaves a marker (Continue).
		held = hold(dir, in, clock)
		locked(dir, func() {
			phase := PhaseIdle
			if os.Remove(continuePath(dir, in.SessionID, in.AgentID)) == nil {
				phase = PhaseModel
			}
			setPhase(dir, in, phase, clock())
		})
	case "StopFailure":
		setPhase(dir, in, PhaseIdle, clock())
	case "SubagentStop":
		held = hold(dir, in, clock)
		_ = os.Remove(threadPath(dir, in.SessionID, in.AgentID))
	case "SessionEnd":
		_ = os.Remove(threadPath(dir, in.SessionID, in.AgentID))
	}
	return held
}

// Continue records that a Stop of the thread was answered with "block", so
// its turn goes on with another model request. It is called by the hook that
// blocks, which runs beside the gate's own Stop hook in no fixed order: when
// the gate already recorded the end of the turn the phase is corrected here,
// otherwise the marker tells the gate's Stop what to record.
func Continue(dir, session, agent string) {
	if dir == "" || session == "" {
		return
	}
	if _, err := os.Stat(dir); err != nil {
		return
	}
	locked(dir, func() {
		path := threadPath(dir, session, agent)
		if t, ok := readThread(path); ok && t.Phase == PhaseIdle {
			t.Phase, t.At, t.Event = PhaseModel, time.Now().UTC(), "StopBlocked"
			raw, _ := json.Marshal(t)
			_ = writeAtomic(path, raw)
			return
		}
		_ = os.WriteFile(continuePath(dir, session, agent), nil, 0o600)
	})
}

// Threads lists the phase files of a gate directory.
func Threads(dir string) []Thread {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []Thread
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, "t-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		if t, ok := readThread(filepath.Join(dir, name)); ok {
			out = append(out, t)
		}
	}
	return out
}

// Safe reports whether no thread of the session can send a model request
// while the pause of the given round is active, and names the thread that
// can otherwise. An empty round accepts whichever pause is active.
//
// It needs an active pause: without one nothing holds the next hook, and a
// thread that is "idle" or in a tool may start a request at any moment.
func Safe(dir, round string, now time.Time) (bool, string) {
	p, ok := Active(dir, now)
	if !ok {
		return false, "no active pause"
	}
	if round != "" && p.Round != round {
		return false, "paused for another round"
	}
	if !Ready(dir) {
		return false, "no hook of this session has run"
	}
	for _, t := range Threads(dir) {
		if t.Phase != PhaseModel || now.Sub(t.At) > modelStale {
			continue
		}
		// An interrupted turn fires no hook; its transcript says so.
		if t.Agent == "" && interrupted(t.Transcript) {
			continue
		}
		who := "root"
		if t.Agent != "" {
			who = "subagent " + t.Agent
		}
		return false, who + " is in a model request since " + t.At.Format(time.RFC3339)
	}
	return true, ""
}

const transcriptTail = 64 << 10

// interrupted reports that the last conversation entry of a transcript is
// Claude Code's own note about a turn the user interrupted.
func interrupted(path string) bool {
	if path == "" {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return false
	}
	offset := info.Size() - transcriptTail
	if offset < 0 {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return false
	}
	tail, err := io.ReadAll(io.LimitReader(f, transcriptTail))
	if err != nil {
		return false
	}
	lines := bytes.Split(tail, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 {
			continue
		}
		var entry struct {
			Type    string `json:"type"`
			IsMeta  bool   `json:"isMeta"`
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &entry) != nil {
			return false
		}
		switch entry.Type {
		case "assistant":
			return false
		case "user":
			if entry.IsMeta {
				continue
			}
			return strings.HasPrefix(strings.TrimSpace(contentText(entry.Message.Content)), "[Request interrupted by user")
		}
	}
	return false
}

func contentText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		for _, part := range parts {
			if part.Type == "text" {
				return part.Text
			}
		}
	}
	return ""
}

// RunHook is the hook process: `cxx agent account-gate`. It prints nothing
// and never fails, so it can only delay Claude Code, never block it.
func RunHook(stdin io.Reader) {
	dir := os.Getenv(EnvDir)
	if dir == "" {
		return
	}
	var in HookInput
	if json.NewDecoder(io.LimitReader(stdin, 1<<20)).Decode(&in) != nil {
		return
	}
	Hook(dir, in)
}
