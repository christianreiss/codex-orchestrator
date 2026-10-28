package communicator

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

// fakeClock records requested waits instead of sleeping.
type fakeClock struct{ waits []time.Duration }

func (c *fakeClock) wait(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.waits = append(c.waits, d)
	return nil
}

var (
	errNotFound = errors.New("404")
	errRevoked  = errors.New("401")
	errOutage   = errors.New("503")
)

func isErrNotFound(err error) bool { return errors.Is(err, errNotFound) }

func TestConfirmNotFoundRechecksBeforeCountingARevocation(t *testing.T) {
	tests := []struct {
		name      string
		answers   []error // recheck answers, in order
		want      error
		wantCalls int
	}{
		{"transient 404 then success", []error{nil}, nil, 1},
		{"404 twice then success", []error{errNotFound, nil}, nil, 2},
		{"persistent 404", []error{errNotFound, errNotFound, errNotFound}, errNotFound, 3},
		{"404 then 401 is immediately revoked", []error{errRevoked}, errRevoked, 1},
		{"404 then outage is not a 404", []error{errNotFound, errOutage}, errOutage, 2},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clock := &fakeClock{}
			calls := 0
			got := ConfirmNotFound(context.Background(), RecheckPolicy{Wait: clock.wait}, func(context.Context) error {
				answer := tc.answers[calls]
				calls++
				return answer
			}, isErrNotFound)
			if !errors.Is(got, tc.want) || (tc.want == nil && got != nil) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			if calls != tc.wantCalls || len(clock.waits) != tc.wantCalls {
				t.Fatalf("%d rechecks, %d waits; want %d each", calls, len(clock.waits), tc.wantCalls)
			}
			for _, d := range clock.waits {
				if d != NotFoundRecheckSpacing {
					t.Fatalf("spacing %s, want %s", d, NotFoundRecheckSpacing)
				}
			}
		})
	}
}

func TestConfirmNotFoundTotalWindowIsAboutFourAndAHalfSeconds(t *testing.T) {
	if got := time.Duration(NotFoundRechecks) * NotFoundRecheckSpacing; got != 4500*time.Millisecond {
		t.Fatalf("window %s", got)
	}
}

func TestConfirmNotFoundContextCancelReturnsPromptly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	calls := 0
	go func() {
		// Real wait with a long spacing: only cancellation can end it in time.
		done <- ConfirmNotFound(ctx, RecheckPolicy{Spacing: time.Hour}, func(context.Context) error {
			calls++
			return errNotFound
		}, isErrNotFound)
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || isErrNotFound(err) {
			t.Fatalf("got %v, want context.Canceled (never a revocation)", err)
		}
		if calls != 0 {
			t.Fatalf("rechecked %d times after cancellation", calls)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ConfirmNotFound did not return after cancellation")
	}
}

func grokAuthResult(raw string) SyncResult {
	if raw == "" {
		return SyncResult{}
	}
	return SyncResult{Error: &SyncError{Message: "fail", HTTP: json.RawMessage(raw)}}
}

func TestConfirmGrokNotFoundMarksFatalOnlyWhenTheNotFoundPersists(t *testing.T) {
	const notFound = `{"StatusCode":404,"Code":"not_found"}`
	tests := []struct {
		name      string
		first     string
		rechecks  []string // results of repeated operations, in order
		wantFatal bool
		wantCalls int
	}{
		{"transient 404 then ok", notFound, []string{""}, false, 1},
		{"persistent 404", notFound, []string{notFound, notFound, notFound}, true, 3},
		{"404 then 401", notFound, []string{`{"StatusCode":401}`}, false, 1}, // sync marks 401 Fatal itself
		{"404 then outage", notFound, []string{notFound, `{"StatusCode":503}`}, false, 2},
		{"401 first is untouched", `{"StatusCode":401}`, nil, false, 0},
		{"409 first is untouched", `{"StatusCode":409,"Code":"account_session_invalid"}`, nil, false, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := &server{}
			job := syncJob{Engine: "grok", Config: "/c", AuthPath: "/a"}
			clock := &fakeClock{}
			grokNotFoundRecheck = RecheckPolicy{Wait: clock.wait}
			t.Cleanup(func() { grokNotFoundRecheck = RecheckPolicy{} })
			calls := 0
			execute := func(context.Context, SyncRequest) SyncResult {
				r := grokAuthResult(tc.rechecks[calls])
				calls++
				return r
			}
			out := s.confirmGrokNotFound(context.Background(), SyncRequest{Job: job, Operation: "auth"}, grokAuthResult(tc.first), execute)
			if calls != tc.wantCalls {
				t.Fatalf("%d repeated operations, want %d", calls, tc.wantCalls)
			}
			s.mu.Lock()
			fatal := s.stateLocked(job).auth.Fatal
			s.mu.Unlock()
			if fatal != tc.wantFatal {
				t.Fatalf("Fatal=%v, want %v (result %+v)", fatal, tc.wantFatal, out.Error)
			}
			if tc.wantCalls == 0 && len(clock.waits) != 0 {
				t.Fatal("a non-404 failure was delayed")
			}
		})
	}
}

func TestConfirmGrokNotFoundCancelledNeverBecomesFatal(t *testing.T) {
	s := &server{}
	job := syncJob{Engine: "grok", Config: "/c", AuthPath: "/a"}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	called := false
	s.confirmGrokNotFound(ctx, SyncRequest{Job: job, Operation: "auth"}, grokAuthResult(`{"StatusCode":404}`), func(context.Context, SyncRequest) SyncResult {
		called = true
		return SyncResult{}
	})
	s.mu.Lock()
	fatal := s.stateLocked(job).auth.Fatal
	s.mu.Unlock()
	if fatal || called {
		t.Fatalf("cancelled context: fatal=%v rechecked=%v", fatal, called)
	}
}
