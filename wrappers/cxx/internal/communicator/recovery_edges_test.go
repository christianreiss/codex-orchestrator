package communicator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
	"github.com/fsnotify/fsnotify"
)

func TestPreparedHandoffQuiescesSchedulerAndResumesSameJournal(t *testing.T) {
	stopped := make(chan struct{}, 1)
	controller := &fakeResidentController{status: residency.ExecutionStatus{Verified: true}}
	s := &server{residentState: &residentState{controller: controller}, stop: func() { stopped <- struct{}{} }, jobs: map[string]syncJob{"due": {}}, fallback: true}
	requestID := "c5e43e97-0068-45a1-a981-539eeb89f4c8"
	call := func(command, id string) int {
		raw, _ := json.Marshal(map[string]string{"command": command, "request_id": id, "owner_instance_id": processInstance})
		w := httptest.NewRecorder()
		residentHandler{s}.ServeHTTP(w, httptest.NewRequest("POST", "/_comm/handoff", strings.NewReader(string(raw))))
		return w.Code
	}
	if got := call("prepare", requestID); got != 200 {
		t.Fatal(got)
	}
	if !s.draining.Load() || !controller.fenced {
		t.Fatal("prepared owner lost its fence")
	}
	for range 100 {
		if delay, scheduled := s.nextSyncWake(false); scheduled {
			t.Fatalf("draining scheduler would spin at %v", delay)
		}
	}
	if got := call("prepare", requestID); got != 200 {
		t.Fatal("same journal cannot recover", got)
	}
	if got := call("commit", "ee8ca372-53cc-4d37-a5fc-9ab62a616e58"); got != http.StatusConflict {
		t.Fatal("different journal accepted", got)
	}
	if got := call("commit", requestID); got != 200 {
		t.Fatal(got)
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("recovered journal did not stop source owner")
	}
	if !controller.fenced {
		t.Fatal("recovery unfenced source execution")
	}
}

func TestDirectoryWatchRecoversAfterReplacement(t *testing.T) {
	for _, operation := range []string{"remove", "rename"} {
		t.Run(operation, func(t *testing.T) {
			watcher, err := fsnotify.NewWatcher()
			if err != nil {
				t.Fatal(err)
			}
			defer watcher.Close()
			root := t.TempDir()
			dir := filepath.Join(root, "auth")
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			if err := watcher.Add(dir); err != nil {
				t.Fatal(err)
			}
			watched := map[string]bool{dir: true}
			if operation == "remove" {
				err = os.Remove(dir)
			} else {
				err = os.Rename(dir, dir+"-old")
			}
			if err != nil {
				t.Fatal(err)
			}
			deadline := time.After(2 * time.Second)
			for watched[dir] {
				select {
				case event := <-watcher.Events:
					forgetReplacedWatch(watcher, watched, event)
				case err := <-watcher.Errors:
					t.Fatal(err)
				case <-deadline:
					t.Fatal("replacement left stale coverage")
				}
			}
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			if err := watcher.Add(dir); err != nil {
				t.Fatal(err)
			}
			watched[dir] = true
			auth := filepath.Join(dir, "auth.json")
			if err := os.WriteFile(auth, []byte("changed"), 0600); err != nil {
				t.Fatal(err)
			}
			deadline = time.After(2 * time.Second)
			for {
				select {
				case event := <-watcher.Events:
					if event.Name == auth {
						return
					}
				case err := <-watcher.Errors:
					t.Fatal(err)
				case <-deadline:
					t.Fatal("recreated source is not watched")
				}
			}
		})
	}
}

func TestUnusedDirectoryWatchesAreReleased(t *testing.T) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.Close()
	dir := t.TempDir()
	if err := watcher.Add(dir); err != nil {
		t.Fatal(err)
	}
	watched := map[string]bool{dir: true}
	pruneUnusedWatches(watcher, watched, map[string]syncJob{"live": {AuthPath: filepath.Join(dir, "auth.json")}})
	if !watched[dir] {
		t.Fatal("live watch removed")
	}
	pruneUnusedWatches(watcher, watched, nil)
	if len(watched) != 0 || len(watcher.WatchList()) != 0 {
		t.Fatal("inactive watches retained")
	}
}

// Exercise the scheduler wiring, not just event classification: after a parent
// replacement the temporary 2s fallback must install a fresh inode watch and
// return to event-driven operation with the original long safety deadline.
func TestSyncLoopRewatchesRecreatedAuthDirectory(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "auth")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	auth := filepath.Join(dir, "auth.json")
	job := syncJob{Engine: "codex", AuthPath: auth, Env: map[string]string{"HOME": root}}
	s := &server{fallback: true, jobs: map[string]syncJob{"scope": job}, authDirty: make(chan struct{}, 1)}
	state := s.stateLocked(job)
	future := time.Now().Add(100 * 365 * 24 * time.Hour)
	state.nextContent = future
	state.contentFresh = time.Now()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.authDirty <- struct{}{}
	go func() { defer close(done); s.syncLoop(ctx) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("scheduler did not stop")
		}
	}()
	observeWrite := func(bound time.Duration) {
		t.Helper()
		changed := s.localChanges()
		timer := time.NewTimer(bound)
		defer timer.Stop()
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-changed:
				return
			case <-tick.C:
				if err := os.WriteFile(auth, []byte("changed"), 0600); err != nil {
					t.Fatal(err)
				}
			case <-timer.C:
				t.Fatal("scheduler did not observe auth source writes")
			}
		}
	}
	observeWrite(2 * time.Second)
	changed := s.localChanges()
	if err := os.Rename(dir, dir+"-old"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-changed:
	case <-time.After(time.Second):
		t.Fatal("scheduler missed parent rename")
	}
	// Let the rename event finish removing the old inode's coverage before the
	// new path appears; subsequent writes can only arrive from a new watch.
	time.Sleep(50 * time.Millisecond)
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	observeWrite(4 * time.Second)
	if delay, scheduled := s.nextSyncWake(true); !scheduled || delay < time.Hour {
		t.Fatalf("restored watch retained idle polling: %s %v", delay, scheduled)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if state.nextContent != future || state.running {
		t.Fatal("watch recovery forced a network content pass")
	}
}

func TestRefusedHandoffRearmsSchedulerAfterTemporaryFence(t *testing.T) {
	s := &server{residentState: &residentState{pending: 1}, authDirty: make(chan struct{}, 1)}
	if reason := s.preflightStop(); reason != "clients_busy" {
		t.Fatal(reason)
	}
	if s.draining.Load() {
		t.Fatal("refused handoff retained its temporary fence")
	}
	select {
	case <-s.authDirty:
	default:
		t.Fatal("scheduler was not rearmed after temporary fence")
	}
}

func TestWatchErrorWakesLeaseObserversWithoutForcingNetworkPass(t *testing.T) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.Close()
	dir := t.TempDir()
	if err := watcher.Add(dir); err != nil {
		t.Fatal(err)
	}
	watched := map[string]bool{dir: true}
	s := &server{dirty: make(chan struct{}, 1)}
	changed := s.localChanges()
	s.recoverWatchCoverage(watcher, watched)
	select {
	case <-changed:
	default:
		t.Fatal("watch overflow left local lease observers asleep")
	}
	if len(watched) != 0 || len(watcher.WatchList()) != 0 {
		t.Fatal("watch error retained stale coverage")
	}
	select {
	case <-s.dirty:
		t.Fatal("watch error forced a network content pass")
	default:
	}
}
