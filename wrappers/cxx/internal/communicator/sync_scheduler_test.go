package communicator

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

// The shared Grok content lease and a private runtime have the same native
// home, but different auth states. Only the shared lease runs content work.
func TestSyncWakeIgnoresPrivateGrokContentDeadline(t *testing.T) {
	root := t.TempDir()
	shared := syncJob{Engine: "grok", Env: map[string]string{"HOME": root}}
	private := shared
	private.Auth = true
	private.Broker = filepath.Join(root, "broker.sock")
	// Use real lease keys and make the private lease sort first, independent of
	// the temporary directory name. That must not change content ownership.
	for i := 0; ; i++ {
		shared.SessionID = fmt.Sprintf("shared-%d", i)
		private.SessionID = fmt.Sprintf("private-%d", i)
		if jobID(private) < jobID(shared) {
			break
		}
		if i == 1000 {
			t.Fatal("could not arrange lease order")
		}
	}
	s := &server{fallback: true, jobs: map[string]syncJob{jobID(shared): shared, jobID(private): private}}
	future := time.Now().Add(time.Hour)
	s.stateLocked(shared).nextContent = future
	state := s.stateLocked(private)
	state.nextAuth = future
	state.born = time.Now().Add(-time.Hour)
	if delay, scheduled := s.nextSyncWake(true); !scheduled || delay < 59*time.Minute {
		t.Fatalf("idle owner would rescan immediately: delay=%s scheduled=%v", delay, scheduled)
	}
}

func TestSyncLoopDoesNotRescanIdleGrokLeases(t *testing.T) {
	root := t.TempDir()
	shared := syncJob{Engine: "grok", Env: map[string]string{"HOME": root}}
	private := shared
	private.Auth = true
	private.Broker = filepath.Join(root, "broker.sock")
	// These keys reproduce the opposing lease/content election order without
	// depending on hashes; the preceding test covers real lease-key generation.
	s := &server{fallback: true, jobs: map[string]syncJob{"a": private, "z": shared}, authDirty: make(chan struct{}, 1)}
	future := time.Now().Add(time.Hour)
	s.stateLocked(shared).nextContent = future
	state := s.stateLocked(private)
	state.nextAuth = future
	state.born = time.Now().Add(-time.Hour)
	before := state.lastUsed
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); s.syncLoop(ctx) }()
	defer func() { cancel(); <-done }()
	s.authDirty <- struct{}{}
	// Wait for the explicit wake to finish, then observe whether unrelated timer
	// wakes keep touching the private state although no work or events are due.
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		used := state.lastUsed
		s.mu.Unlock()
		if used.After(before) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("scheduler ignored explicit wake")
		}
		time.Sleep(time.Millisecond)
	}
	changes := 0
	for range 10 {
		s.mu.Lock()
		before = state.lastUsed
		s.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
		s.mu.Lock()
		if state.lastUsed.After(before) {
			changes++
		}
		s.mu.Unlock()
	}
	if changes > 1 {
		t.Fatalf("idle sync loop kept rescanning in %d/10 observation windows", changes)
	}
	t.Logf("idle rescan windows: %d/10", changes)
}

func TestSyncWakeKeepsEveryGrokBrokerAuthDeadline(t *testing.T) {
	root := t.TempDir()
	shared := syncJob{Engine: "grok", Env: map[string]string{"HOME": root}}
	a := shared
	a.Auth, a.Broker = true, filepath.Join(root, "a.sock")
	b := a
	b.Broker = filepath.Join(root, "b.sock")
	s := &server{fallback: true, jobs: map[string]syncJob{"first": b, "second": a, "last": shared}}
	future := time.Now().Add(time.Hour)
	s.stateLocked(shared).nextContent = future
	for _, job := range []syncJob{a, b} {
		state := s.stateLocked(job)
		state.nextAuth = future
		state.born = time.Now().Add(-time.Hour)
	}
	if delay, _ := s.nextSyncWake(true); delay < 59*time.Minute {
		t.Fatalf("nonowner content deadline armed timer: %s", delay)
	}
	for _, job := range []syncJob{a, b} {
		state := s.scopes[stateID(job)]
		state.nextAuth = time.Time{}
		if delay, scheduled := s.nextSyncWake(true); !scheduled || delay != 0 {
			t.Fatalf("broker auth deadline lost: %s %v", delay, scheduled)
		}
		state.nextAuth = future
	}
	// Removing the shared lease elects broker a for content immediately, even
	// though all auth is current. Removing a must then elect b, not its old state.
	delete(s.jobs, "last")
	if delay, _ := s.nextSyncWake(true); delay != 0 {
		t.Fatalf("replacement content owner was not scheduled: %s", delay)
	}
	s.scopes[stateID(a)].nextContent = future
	if delay, _ := s.nextSyncWake(true); delay < 59*time.Minute {
		t.Fatalf("unelected broker kept timer due: %s", delay)
	}
	delete(s.jobs, "second")
	if delay, _ := s.nextSyncWake(true); delay != 0 {
		t.Fatalf("last broker did not inherit content work: %s", delay)
	}
}

func TestSyncWakePreservesEngineDeadlinesAndGates(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok", "kimi"} {
		t.Run(engine, func(t *testing.T) {
			job := syncJob{Engine: engine, Auth: true, Env: map[string]string{"HOME": t.TempDir()}}
			content := job
			content.Auth = false
			s := &server{fallback: true, jobs: map[string]syncJob{"a-content": content, "z-auth": job}}
			state := s.stateLocked(job)
			future := time.Now().Add(time.Hour)
			state.nextAuth, state.nextContent = future, future
			if engine == "grok" || engine == "kimi" {
				s.stateLocked(content).nextContent = future
			}
			if delay, _ := s.nextSyncWake(true); delay < 59*time.Minute {
				t.Fatalf("idle engine wakes early: %s", delay)
			}
			if delay, _ := s.nextSyncWake(false); delay <= 0 || delay > 2*time.Second {
				t.Fatalf("missing-watch fallback lost: %s", delay)
			}
			contentState := s.scopes[stateID(content)]
			if engine != "grok" && engine != "kimi" {
				contentState = state
			}
			contentState.nextContent = time.Time{}
			contentState.born = time.Now()
			if delay, scheduled := s.nextSyncWake(true); !scheduled || delay <= 0 || delay > initialContentGrace {
				t.Fatalf("initial content grace lost: %s %v", delay, scheduled)
			}
			contentState.born = time.Now().Add(-time.Hour)
			if delay, scheduled := s.nextSyncWake(true); !scheduled || delay != 0 {
				t.Fatalf("due content missed: %s %v", delay, scheduled)
			}
			contentState.nextContent = future
			state.nextAuth = time.Time{}
			if delay, scheduled := s.nextSyncWake(true); !scheduled || delay != 0 {
				t.Fatalf("due auth missed: %s %v", delay, scheduled)
			}
			for _, running := range []bool{true, false} {
				state.running, state.suspended = running, !running
				if delay, scheduled := s.nextSyncWake(true); scheduled && delay < 59*time.Minute {
					t.Fatalf("inactive auth state spins: %s", delay)
				}
			}
			state.running, state.suspended = false, false
			s.draining.Store(true)
			if _, scheduled := s.nextSyncWake(false); scheduled {
				t.Fatal("draining owner scheduled work")
			}
			s.draining.Store(false)
			s.fallback = false
			if _, scheduled := s.nextSyncWake(false); scheduled {
				t.Fatal("disconnected owner scheduled work")
			}
			s.fallback = true
			delete(s.scopes, stateID(job))
			if delay, scheduled := s.nextSyncWake(true); !scheduled || delay != 0 {
				t.Fatalf("new auth state missed: %s %v", delay, scheduled)
			}
		})
	}
}
