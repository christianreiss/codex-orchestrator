package communicator

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

// A worker that is killed while its request still waits for the connection never
// learns that nothing was sent, so it cannot take its offline path.
func TestConnectBudgetEndsInsideTheAuthWorkerDeadline(t *testing.T) {
	if connectWaitFirst+3*time.Second > authWorkerTimeout {
		t.Fatalf("a request may wait %s for the connection but the auth worker is killed after %s", connectWaitFirst, authWorkerTimeout)
	}
}

// Requests share the budget of the attempt in flight. Against a hung API the second
// and third call of one command must not each sit out a full budget.
func TestWaitConnectionSharesTheBudgetOfTheAttemptInFlight(t *testing.T) {
	s := newTestServer(0, time.Time{})
	s.attempting = true
	s.attemptStarted = time.Now().Add(-connectWaitFirst + 300*time.Millisecond)
	started := time.Now()
	for i, max := range []time.Duration{time.Second, 150 * time.Millisecond, 150 * time.Millisecond} {
		before := time.Now()
		if c := s.waitConnection(context.Background()); c != nil {
			t.Fatal("no connection exists")
		}
		if took := time.Since(before); took > max {
			t.Fatalf("call %d waited %s, the attempt's budget was nearly spent (max %s)", i+1, took, max)
		}
	}
	if total := time.Since(started); total > 1500*time.Millisecond {
		t.Fatalf("three calls against one hung attempt took %s in total", total)
	}
}

// After the connection was lost a redial is expected within moments, so a hung
// attempt is reported long before the cold-start budget.
func TestWaitConnectionGivesAHungRedialAShortBudget(t *testing.T) {
	if redialWait >= connectWaitFirst {
		t.Fatalf("redial budget %s must be shorter than the first-connect budget %s", redialWait, connectWaitFirst)
	}
	s := newTestServer(2, time.Now().Add(-time.Minute))
	s.attempting = true
	s.attemptStarted = time.Now().Add(-redialWait + 300*time.Millisecond)
	for i, max := range []time.Duration{time.Second, 150 * time.Millisecond} {
		before := time.Now()
		if c := s.waitConnection(context.Background()); c != nil {
			t.Fatal("no connection exists")
		}
		if took := time.Since(before); took > max {
			t.Fatalf("call %d waited %s on a redial that is already %s old (max %s)", i+1, took, redialWait, max)
		}
	}
}

func TestWaitConnectionRefusesToWaitOnAnAttemptThatOutlivedTheBudget(t *testing.T) {
	s := newTestServer(0, time.Time{})
	s.attempting = true
	s.attemptStarted = time.Now().Add(-connectWaitFirst - time.Second)
	before := time.Now()
	if c := s.waitConnection(context.Background()); c != nil || time.Since(before) > 150*time.Millisecond {
		t.Fatalf("a request arriving after the budget must be answered at once (%s)", time.Since(before))
	}
}

func TestWaitConnectionStillAcceptsAConnectionThatArrivesInsideTheBudget(t *testing.T) {
	want := &connection{}
	s := newTestServer(0, time.Time{})
	s.attempting = true
	s.attemptStarted = time.Now().Add(-connectWaitFirst + 2*time.Second)
	go func() {
		time.Sleep(300 * time.Millisecond)
		s.mu.Lock()
		s.conn, s.attempting = want, false
		s.mu.Unlock()
	}()
	if got := s.waitConnection(context.Background()); got != want {
		t.Fatal("the connection that arrived inside the budget was missed")
	}
}

func ownerWithConnection(t *testing.T, handler func(*websocket.Conn, frame)) (*server, *connection) {
	t.Helper()
	c := testConnection(t, handler)
	return &server{cfg: &config.Config{Orchestrator: config.Orchestrator{BaseURL: "http://127.0.0.1:1"}}, conn: c, calls: map[string]*sharedCall{}}, c
}

// 503 means "not sent, retry is safe"; it is only ever returned when no frame was
// written. Anything that may have reached the server is 409 communicator_outcome_unknown.
func TestDispatchBoundaryDecidesBetweenUnavailableAndUnknown(t *testing.T) {
	post := func(s *server) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("POST", "/auth", strings.NewReader(`{"command":"store"}`)))
		return w
	}

	t.Run("connection already ended: provably not sent", func(t *testing.T) {
		var frames atomic.Int32
		s, c := ownerWithConnection(t, func(ws *websocket.Conn, f frame) { frames.Add(1) })
		c.ws.Close()
		<-c.done
		w := post(s)
		if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "communicator_unavailable") {
			t.Fatalf("not-sent request answered %d %s", w.Code, w.Body.String())
		}
		if frames.Load() != 0 {
			t.Fatalf("%d frames reached the server for a request reported as not sent", frames.Load())
		}
	})

	t.Run("connection lost after the frame was delivered: unknown", func(t *testing.T) {
		var frames atomic.Int32
		s, _ := ownerWithConnection(t, func(ws *websocket.Conn, f frame) {
			frames.Add(1)
			ws.Close() // the effect may have happened; the reply is lost
		})
		w := post(s)
		if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "communicator_outcome_unknown") {
			t.Fatalf("possibly-executed request answered %d %s", w.Code, w.Body.String())
		}
		if frames.Load() != 1 {
			t.Fatalf("expected one delivered frame, got %d", frames.Load())
		}
	})

	t.Run("no connection within the budget: not sent", func(t *testing.T) {
		s := newTestServer(0, time.Time{})
		s.attempting = true
		s.attemptStarted = time.Now().Add(-connectWaitFirst + 300*time.Millisecond)
		s.cfg = &config.Config{Orchestrator: config.Orchestrator{BaseURL: "http://127.0.0.1:1"}}
		w := post(s)
		if w.Code != http.StatusServiceUnavailable || strings.Contains(w.Body.String(), "outcome_unknown") {
			t.Fatalf("answered %d %s", w.Code, w.Body.String())
		}
	})
}
