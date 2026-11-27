package accountpool

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountgate"
)

func pauseContext(t *testing.T) *Context {
	t.Helper()
	c := Load("claude", filepath.Join(t.TempDir(), ".credentials.json"), "https://orchestrator.example")
	c.SessionID = "0123456789abcdef0123456789abcdef"
	return c
}

func TestObservePauseFixesTheDeadlineWhenARoundIsFirstSeen(t *testing.T) {
	c := pauseContext(t)
	start := time.Now()
	changed := c.PauseChanged()
	c.observePause(&PauseCommand{Round: "r1", HoldMS: 60_000}, start)
	select {
	case <-changed:
	default:
		t.Fatal("a new round did not wake the pause agent")
	}
	command, deadline, ok := c.Pause(start)
	if !ok || command.Round != "r1" || command.Ready || !deadline.Equal(start.Add(time.Minute)) {
		t.Fatalf("pause %+v until %v (ok=%v)", command, deadline, ok)
	}
	// A later snapshot of the same round, built later, says "ready" and a
	// fresh remaining time. The hooks are not held any longer for it.
	changed = c.PauseChanged()
	c.observePause(&PauseCommand{Round: "r1", HoldMS: 60_000, Ready: true}, start.Add(30*time.Second))
	select {
	case <-changed:
	default:
		t.Fatal("ready did not wake the pause agent")
	}
	command, deadline, _ = c.Pause(start)
	if !command.Ready || !deadline.Equal(start.Add(time.Minute)) {
		t.Fatalf("after ready: %+v until %v", command, deadline)
	}
	// The same snapshot again changes nothing and wakes nobody.
	changed = c.PauseChanged()
	c.observePause(&PauseCommand{Round: "r1", HoldMS: 60_000, Ready: true}, start.Add(40*time.Second))
	select {
	case <-changed:
		t.Fatal("an unchanged pause woke the agent")
	default:
	}
	// Past its local deadline a round is over, whatever the server last said.
	if _, _, ok := c.Pause(start.Add(61 * time.Second)); ok {
		t.Fatal("a pause outlived its deadline")
	}
	// The server ends the round.
	c.observePause(nil, start.Add(41*time.Second))
	if _, _, ok := c.Pause(start.Add(42 * time.Second)); ok {
		t.Fatal("a pause survived its resume")
	}
	// No server may hold hooks longer than the gate's own maximum.
	c.observePause(&PauseCommand{Round: "r2", HoldMS: int64(time.Hour / time.Millisecond)}, start)
	if _, deadline, _ := c.Pause(start); !deadline.Equal(start.Add(accountgate.MaxHold)) {
		t.Fatalf("deadline %v exceeds the gate maximum", deadline.Sub(start))
	}
}

func TestProviderPauseIsMeasuredOnTheServerClock(t *testing.T) {
	var state providerState
	raw := `{"provider_session_id":"x","engine":"claude","account_id":8,"pause":{"round":"r1","deadline":"2026-11-27T10:01:30.000Z","ready":true}}`
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		t.Fatal(err)
	}
	// The local clock may be anywhere; only the server's "now" counts.
	serverNow := time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)
	command := state.Pause.command(serverNow)
	if command == nil || command.Round != "r1" || !command.Ready || command.HoldMS != 90_000 {
		t.Fatalf("command %+v", command)
	}
	if late := state.Pause.command(serverNow.Add(time.Hour)); late == nil || late.HoldMS != 0 {
		t.Fatalf("a round past its deadline: %+v", late)
	}
	// No pause, and a pause that cannot be read, hold nothing.
	state = providerState{}
	_ = json.Unmarshal([]byte(`{"pause":null}`), &state)
	if state.Pause.command(serverNow) != nil {
		t.Fatal("null pause became a command")
	}
	if (&providerPause{Round: "r1", Deadline: "soon"}).command(serverNow) != nil {
		t.Fatal("an unreadable deadline became a command")
	}
}

func TestReadyRoundPokesTheSwitchSupervisor(t *testing.T) {
	c := pauseContext(t)
	wake := c.SwitchWake()
	c.observePause(&PauseCommand{Round: "r1", HoldMS: 1000, Ready: true}, time.Now())
	select {
	case <-wake:
	default:
		t.Fatal("the supervisor was not woken for a ready round")
	}
}

func TestGateDirectoryFollowsTheLaunchAndItsEnvironment(t *testing.T) {
	c := pauseContext(t)
	t.Setenv(accountgate.EnvDir, "/inherited/from/the/parent")
	// A launch without a gate must not hand its child the parent's.
	restore := c.ActivateEnvironment()
	if got := os.Getenv(accountgate.EnvDir); got != "" {
		t.Fatalf("a launch without a gate exported %q", got)
	}
	restore()
	if got := os.Getenv(accountgate.EnvDir); got != "/inherited/from/the/parent" {
		t.Fatalf("environment not restored: %q", got)
	}
	remove := c.prepareGate(c.SessionID)
	dir := c.GateDir()
	if info, err := os.Stat(dir); err != nil || !info.IsDir() || dir != accountgate.Dir(c.markerDir(), c.SessionID) {
		t.Fatalf("gate directory %q: %v", dir, err)
	}
	restore = c.ActivateEnvironment()
	if got := os.Getenv(accountgate.EnvDir); got != dir {
		t.Fatalf("exported %q, want %q", got, dir)
	}
	restore()
	remove()
	if _, err := os.Stat(dir); err == nil || c.GateDir() != "" {
		t.Fatal("the gate directory outlived its launch")
	}
	// Other engines have no hooks to hold.
	other := Load("codex", filepath.Join(t.TempDir(), "auth.json"), "https://orchestrator.example")
	other.prepareGate("0123456789abcdef0123456789abcdef")()
	if other.GateDir() != "" {
		t.Fatal("a Codex launch got a gate")
	}
}

func TestScopeSafeNeedsEveryLiveLaunchPaused(t *testing.T) {
	c := pauseContext(t)
	removeMarker := c.writeSessionMarker(c.SessionID)
	defer removeMarker()
	defer c.prepareGate(c.SessionID)()
	// A sibling of the scope: a live process (this one) without a gate, as a
	// wrapper before pause rounds leaves it.
	sibling := "fedcba9876543210fedcba9876543210"
	defer c.writeSessionMarker(sibling)()

	deadline := time.Now().Add(time.Minute)
	accountgate.Hook(c.GateDir(), accountgate.HookInput{Event: "Stop", SessionID: "s1"})
	_ = accountgate.Activate(c.GateDir(), accountgate.Pause{Round: "r1", Deadline: deadline})
	if safe, why := c.ScopeSafe("r1", time.Now()); safe {
		t.Fatal("safe although a sibling has no gate")
	} else if why == "" {
		t.Fatal("no reason given")
	}
	siblingGate := accountgate.Dir(c.markerDir(), sibling)
	if err := accountgate.Prepare(siblingGate); err != nil {
		t.Fatal(err)
	}
	accountgate.Hook(siblingGate, accountgate.HookInput{Event: "UserPromptSubmit", SessionID: "s2"})
	_ = accountgate.Activate(siblingGate, accountgate.Pause{Round: "r1", Deadline: deadline})
	if safe, _ := c.ScopeSafe("r1", time.Now()); safe {
		t.Fatal("safe although the sibling is in a model request")
	}
	accountgate.Hook(siblingGate, accountgate.HookInput{Event: "PreToolUse", SessionID: "s2"})
	if safe, why := c.ScopeSafe("r1", time.Now()); !safe {
		t.Fatalf("both launches are at rest, but: %s", why)
	}
	if safe, _ := c.ScopeSafe("r2", time.Now()); safe {
		t.Fatal("safe for a round nobody is paused for")
	}
}

type recordingClient struct {
	paths  []string
	bodies []map[string]any
	answer string
}

func (r *recordingClient) JSON(_ context.Context, _ string, path string, in any, out any, _ int) error {
	r.paths = append(r.paths, path)
	body, _ := in.(map[string]any)
	r.bodies = append(r.bodies, body)
	if lease, ok := out.(*LeaseResponse); ok {
		id, _ := body["account_id"].(int64)
		*lease = LeaseResponse{AccountID: id, VerificationState: "verified", Auth: []byte(`{}`)}
	}
	if beat, ok := out.(*bindingFields); ok && r.answer == "capable" {
		yes := true
		beat.PauseCapable = &yes
	}
	return nil
}

func TestCommitCarriesTheReadyRoundAndReportsCarryTheSession(t *testing.T) {
	c := pauseContext(t)
	c.AccountID, c.BindingGeneration = 3, 9
	client := &recordingClient{answer: "capable"}
	directive := SwitchDirective{AccountID: 7, BindingGeneration: 9}
	if _, err := c.CommitSwitch(context.Background(), client, directive); err != nil {
		t.Fatal(err)
	}
	if _, has := client.bodies[0]["pause_round"]; has {
		t.Fatal("a commit outside a pause round named one")
	}
	// Asked to pause but not ready: still not a commit of that round.
	c.observePause(&PauseCommand{Round: "r1", HoldMS: 60_000}, time.Now())
	_, _ = c.CommitSwitch(context.Background(), client, directive)
	if _, has := client.bodies[1]["pause_round"]; has {
		t.Fatal("a commit named a round that is not ready")
	}
	c.observePause(&PauseCommand{Round: "r1", HoldMS: 60_000, Ready: true}, time.Now())
	_, _ = c.CommitSwitch(context.Background(), client, directive)
	if got := client.bodies[2]["pause_round"]; got != "r1" {
		t.Fatalf("pause_round %v in a ready round", got)
	}
	// The unfinished report repeats a commit; it is not one of the round.
	_ = c.ReportUnfinishedSwitch(context.Background(), client, directive)
	if _, has := client.bodies[3]["pause_round"]; has || client.bodies[3]["credential_write"] != "unfinished" {
		t.Fatalf("unfinished report: %v", client.bodies[3])
	}

	if capable, known := c.PauseCapable(); known || capable {
		t.Fatal("capability known before the server said anything")
	}
	if err := c.ReportPause(context.Background(), client, "", PauseStateCapable, ""); err != nil {
		t.Fatal(err)
	}
	last := client.bodies[len(client.bodies)-1]
	if client.paths[len(client.paths)-1] != "/auth/sessions/pause" || last["session_id"] != c.SessionID || last["state"] != "capable" || last["engine"] != "claude" {
		t.Fatalf("report: %v", last)
	}
	if _, has := last["round"]; has {
		t.Fatal("the capability announcement named a round")
	}
	if capable, known := c.PauseCapable(); !known || !capable {
		t.Fatal("the server's answer was not taken")
	}
	// The repair report repeats the commit that led to the current binding.
	_ = c.ReportUnfinishedRepair(context.Background(), client)
	last = client.bodies[len(client.bodies)-1]
	if last["account_id"] != int64(3) || last["binding_generation"] != int64(8) || last["credential_write"] != "unfinished" {
		t.Fatalf("repair report: %v", last)
	}
}
