package agentbus

import (
	"context"
	"testing"
	"time"
)

type aedQueue struct {
	turnID, turnStatus, state string
	sent                      []string
}

func (q *aedQueue) identity() (string, error) { return "native", nil }
func (q *aedQueue) status() (string, error)   { return q.state, nil }
func (q *aedQueue) send(id, content string) error {
	q.sent = append(q.sent, content)
	return nil
}
func (q *aedQueue) close() {}
func (q *aedQueue) observeLatestFailure() (string, string, bool, string, error) {
	return "", "", false, "", nil
}
func (q *aedQueue) completedTurn() string                 { return "" }
func (q *aedQueue) latestTurnID() (string, string, error) { return q.turnID, q.turnStatus, nil }

func TestCapacityBackoff(t *testing.T) {
	want := []time.Duration{15 * time.Second, 30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 5 * time.Minute, 5 * time.Minute}
	for i, w := range want {
		if got := capacityBackoff(i); got != w {
			t.Fatalf("attempt %d: %v want %v", i, got, w)
		}
	}
}

func TestCapacityContinuerBudgetAndReset(t *testing.T) {
	var c capacityContinuer
	now := time.Now()
	for i := 0; i < capacityContinueMaxAttempts; i++ {
		if !c.arm(now, "t", "") {
			t.Fatalf("attempt %d refused", i)
		}
		if _, ready := c.pending(now); ready {
			t.Fatal("ready before backoff elapsed")
		}
		if _, ready := c.pending(now.Add(capacityBackoff(i))); !ready {
			t.Fatal("not ready after backoff")
		}
		c.fired()
	}
	if c.arm(now, "t", "") {
		t.Fatal("budget not enforced")
	}
	c.noteCompleted("done")
	if !c.arm(now, "t2", "") {
		t.Fatal("completed turn did not reset the budget")
	}
	c.noteCompleted("done")
	if _, ready := c.pending(now.Add(time.Hour)); !ready {
		t.Fatal("same completed turn must not disarm")
	}
}

func TestCapacityContinuerProviderHint(t *testing.T) {
	var c capacityContinuer
	now := time.Now()
	if c.arm(now, "t", now.Add(2*time.Hour).UTC().Format(time.RFC3339)) {
		t.Fatal("a multi-hour reset is an account limit, not a blip")
	}
	soon := now.Add(3 * time.Minute)
	if !c.arm(now, "t", soon.UTC().Format(time.RFC3339)) {
		t.Fatal("short hint refused")
	}
	if _, ready := c.pending(now.Add(time.Minute)); ready {
		t.Fatal("hint later than backoff was ignored")
	}
}

func TestFireCapacityContinueGuards(t *testing.T) {
	now := time.Now()
	for name, tc := range map[string]struct {
		queue   aedQueue
		enabled bool
		want    int
	}{
		"idle failed turn":      {aedQueue{turnID: "t", turnStatus: "failed", state: "idle"}, true, 1},
		"capacity system error": {aedQueue{turnID: "t", turnStatus: "failed", state: "systemError"}, true, 1},
		"user typed instead":    {aedQueue{turnID: "newer", turnStatus: "inProgress", state: "active"}, true, 0},
		"newer failed turn":     {aedQueue{turnID: "newer", turnStatus: "failed", state: "systemError"}, true, 0},
		"user stopped":          {aedQueue{turnID: "t", turnStatus: "interrupted", state: "idle"}, true, 0},
		"thread unloaded":       {aedQueue{turnID: "t", turnStatus: "failed", state: "notLoaded"}, true, 0},
		"unknown thread state":  {aedQueue{turnID: "t", turnStatus: "failed", state: "future"}, true, 0},
		"thread busy":           {aedQueue{turnID: "t", turnStatus: "failed", state: "active"}, true, 0},
		"toggle off":            {aedQueue{turnID: "t", turnStatus: "failed", state: "idle"}, false, 0},
	} {
		q := tc.queue
		r := &autoReceiver{queue: &q, capacityContinueEnabled: func() bool { return tc.enabled }}
		r.aed.arm(now.Add(-time.Hour), "t", "")
		if err := r.fireCapacityContinue(context.Background(), now); err != nil {
			t.Fatal(name, err)
		}
		if len(q.sent) != tc.want {
			t.Fatalf("%s: sent %d want %d", name, len(q.sent), tc.want)
		}
		if tc.want == 1 && q.sent[0] != capacityContinuePrompt {
			t.Fatal(name, q.sent[0])
		}
	}
}

func TestTransientCapacityError(t *testing.T) {
	for text, want := range map[string]bool{
		"selected model is at capacity. please try a different model.": true,
		"server overloaded":                      true,
		"rate_limit_exceeded: model at capacity": false,
		"you've hit your usage limit":            false,
		"model at capacity, quota limit reached": false,
		"context length exceeded":                false,
	} {
		if got := transientCapacityError(text); got != want {
			t.Errorf("%q: %v want %v", text, got, want)
		}
	}
}
