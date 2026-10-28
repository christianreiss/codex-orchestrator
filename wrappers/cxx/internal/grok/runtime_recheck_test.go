package grok

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

type recheckClock struct{ waits int }

func (c *recheckClock) wait(ctx context.Context, _ time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.waits++
	return nil
}

func TestReadinessTreatsA404AsRevokedOnlyWhenItPersists(t *testing.T) {
	notFound := &orchestrator.HTTPError{StatusCode: 404, Code: "not_found"}
	tests := []struct {
		name      string
		answers   []error // every call in order, the first being the original check
		wantFatal bool
		wantCalls int
		wantWaits int
	}{
		{"transient 404 then 200", []error{notFound, nil}, false, 2, 1},
		{"404, 404, then 200", []error{notFound, notFound, nil}, false, 3, 2},
		{"persistent 404", []error{notFound, notFound, notFound, notFound}, true, 4, 3},
		{"401 is immediate", []error{&orchestrator.HTTPError{StatusCode: 401}}, true, 1, 0},
		{"409 revoked is immediate", []error{&orchestrator.HTTPError{StatusCode: 409, Code: "account_session_invalid"}}, true, 1, 0},
		{"409 unknown outcome is never fatal", []error{&orchestrator.HTTPError{StatusCode: 409, Code: "communicator_outcome_unknown"}}, false, 1, 0},
		{"404 then 401 is revoked at once", []error{notFound, &orchestrator.HTTPError{StatusCode: 401}}, true, 2, 1},
		{"404 then outage is not fatal", []error{notFound, &orchestrator.HTTPError{StatusCode: 503}}, false, 2, 1},
		{"success", []error{nil}, false, 1, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clock := &recheckClock{}
			calls := 0
			err := confirmRefresh(context.Background(), communicator.RecheckPolicy{Wait: clock.wait}, func(context.Context) error {
				answer := tc.answers[calls]
				calls++
				return answer
			})
			if FatalAuthError(err) != tc.wantFatal || calls != tc.wantCalls || clock.waits != tc.wantWaits {
				t.Fatalf("fatal=%v calls=%d waits=%d; want fatal=%v calls=%d waits=%d (err %v)", FatalAuthError(err), calls, clock.waits, tc.wantFatal, tc.wantCalls, tc.wantWaits, err)
			}
		})
	}
}

func TestReadinessRecheckStopsPromptlyWhenTheSessionEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		// Real clock with an hour of spacing: only cancellation can end the wait.
		done <- confirmRefresh(ctx, communicator.RecheckPolicy{Spacing: time.Hour}, func(context.Context) error {
			return &orchestrator.HTTPError{StatusCode: 404}
		})
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if FatalAuthError(err) || !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled recheck returned %v; want context.Canceled, never fatal", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("readiness recheck did not stop after cancellation")
	}
}
