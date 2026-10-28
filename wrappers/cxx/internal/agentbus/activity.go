package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"reflect"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
)

type activityObservation = agentportal.ActivityObservation

func codexActivity(state string, flags []string) activityObservation {
	a := activityObservation{State: "unknown", Source: "codex-thread"}
	switch state {
	case "idle":
		a.State = "idle"
	case "active":
		a.State = "working"
		for _, reason := range []struct{ flag, reason string }{{"waitingOnApproval", "approval"}, {"waitingOnUserInput", "input"}} {
			for _, flag := range flags {
				if flag == reason.flag {
					a.State = "waiting"
					v := reason.reason
					a.WaitReason = &v
					return a
				}
			}
		}
	}
	return a
}

func (q *nativeQueue) activity() (activityObservation, error) {
	var read struct {
		Thread struct {
			Status struct {
				Type  string   `json:"type"`
				Flags []string `json:"activeFlags"`
			} `json:"status"`
		} `json:"thread"`
	}
	err := q.call("thread/read", map[string]any{"threadId": q.thread, "includeTurns": false}, &read)
	return codexActivity(read.Thread.Status.Type, read.Thread.Status.Flags), err
}

func grokActivity(state string) activityObservation {
	a := activityObservation{State: "unknown", Source: "grok-session"}
	switch state {
	case "idle":
		a.State = "idle"
	case "working":
		a.State = "working"
	case "needs_input":
		a.State = "waiting"
		reason := "input"
		a.WaitReason = &reason
	}
	return a
}

type activityReader interface {
	activity() (activityObservation, error)
	close()
}

func (q *grokQueue) activity() (activityObservation, error) {
	state, err := q.status()
	return grokActivity(state), err
}

// Separate passive connection: delivery ownership, held messages and approval RPCs
// cannot stall observation. No turn/start, prompt or approval reply is sent here.
func openActivityReader(ctx context.Context, engine, nativeID string) (activityReader, error) {
	if engine == "grok" {
		q, err := openGrokQueue(ctx, os.Getenv("CXX_GROK_SOCKET"), nativeID)
		if err != nil {
			return nil, err
		}
		return q, nil
	}
	q, err := openNativeQueue(ctx, os.Getenv("CXX_CODEX_SOCKET"))
	if err != nil {
		return nil, err
	}
	q.thread = nativeID
	return q, nil
}

func (r *autoReceiver) observeActivity(ctx context.Context, engine, nativeID, generation string, binding int) {
	var reader activityReader
	defer func() {
		if reader != nil {
			reader.close()
		}
	}()
	var seq int64
	var last activityObservation
	var sent time.Time
	var proofEpoch string
	var proofBaseline uint64
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		source := map[string]string{"codex": "codex-thread", "grok": "grok-session", "claude": "claude-hooks"}[engine]
		a := activityObservation{State: "unknown", Source: source}
		var err error
		if engine == "claude" {
			err = r.client.receiver(ctx, "activity-hook", agentportal.ActivityHook{NativeID: nativeID, Observer: true}, &a)
		} else {
			if reader == nil {
				reader, err = openActivityReader(ctx, engine, nativeID)
			}
			if err == nil {
				a, err = reader.activity()
			}
			if err != nil && reader != nil {
				reader.close()
				reader = nil
			}
		}
		if err != nil {
			a = activityObservation{State: "unknown", Source: source}
		}
		if engine == "claude" {
			r.mu.Lock()
			currentGeneration := r.generation
			r.mu.Unlock()
			if currentGeneration != "" && currentGeneration != generation {
				return
			}
			r.observeClaudeTurn(a)
		}
		reason := func(v *string) string {
			if v == nil {
				return ""
			}
			return *v
		}
		// Changes only: a receiver_bound observation stays current on the server
		// while this receiver keeps heartbeating. Resending an unchanged state
		// every 15 s was about 0.7 requests/s fleet-wide.
		r.mu.Lock()
		timingEnabled := r.deliveryTimingV1
		r.mu.Unlock()
		if sent.IsZero() || a.State != last.State || reason(a.WaitReason) != reason(last.WaitReason) || (timingEnabled && !reflect.DeepEqual(a.TurnProof, last.TurnProof)) {
			seq++
			body := map[string]any{"generation": generation, "binding_generation": binding, "native_session_id": nativeID,
				"sequence": seq, "state": a.State, "wait_reason": a.WaitReason, "source": a.Source, "evidence_age_ms": a.EvidenceAgeMS,
				"receiver_bound": true}
			if timingEnabled && a.TurnProof != nil {
				proof := *a.TurnProof
				if proofEpoch != proof.Epoch {
					proofEpoch = proof.Epoch
					proofBaseline = proof.Sequence
				}
				// A restarted observer cannot re-anchor an already cached idle
				// Stop. Pin unknown at the first observed sequence; only a new
				// lifecycle event may establish the next boundary.
				if proof.Sequence <= proofBaseline {
					proof.State = "unknown"
				}

				body["turn_proof"] = proof
			}
			sendCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			var out map[string]any
			err = r.client.sessionPost(sendCtx, "activity", body, &out)
			cancel()
			if err == nil {
				last = a
				sent = time.Now()
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func reportActivityHook(stdin io.Reader) error {
	var h struct {
		SessionID string `json:"session_id"`
		Event     string `json:"hook_event_name"`
		Tool      string `json:"tool_name"`
		Source    string `json:"source"`
	}
	if err := json.NewDecoder(io.LimitReader(stdin, 1<<20)).Decode(&h); err != nil {
		return err
	}
	timeout := activityHookTimeout(h.Event)
	client, err := sessionClientFromEnv(timeout)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return client.receiver(ctx, "activity-hook", agentportal.ActivityHook{NativeID: h.SessionID, Event: h.Event, Tool: h.Tool, Source: h.Source}, nil)
}

// Turn boundaries must outlive the broker's bounded serialized channel callback.
// Other telemetry hooks keep their existing half-second budget.
func activityHookTimeout(event string) time.Duration {
	if event == "UserPromptSubmit" || event == "Stop" {
		return 5 * time.Second
	}
	return 500 * time.Millisecond
}
