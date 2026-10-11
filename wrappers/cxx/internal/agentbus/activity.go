package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"os"
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
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		source := map[string]string{"codex": "codex-thread", "grok": "grok-session", "claude": "claude-hooks"}[engine]
		a := activityObservation{State: "unknown", Source: source}
		var err error
		if engine == "claude" {
			err = r.client.receiver(ctx, "activity-hook", map[string]any{"native_session_id": nativeID}, &a)
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
		reason := func(v *string) string {
			if v == nil {
				return ""
			}
			return *v
		}
		if sent.IsZero() || a.State != last.State || reason(a.WaitReason) != reason(last.WaitReason) || time.Since(sent) >= 15*time.Second {
			seq++
			body := map[string]any{"generation": generation, "binding_generation": binding, "native_session_id": nativeID,
				"sequence": seq, "state": a.State, "wait_reason": a.WaitReason, "source": a.Source, "evidence_age_ms": a.EvidenceAgeMS}
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
	}
	if err := json.NewDecoder(io.LimitReader(stdin, 1<<20)).Decode(&h); err != nil {
		return err
	}
	client, err := sessionClientFromEnv(500 * time.Millisecond)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	return client.receiver(ctx, "activity-hook", agentportal.ActivityHook{NativeID: h.SessionID, Event: h.Event, Tool: h.Tool}, nil)
}
