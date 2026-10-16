package communicator

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// installedImage writes an executable and returns its image as an owner
// started from it would record it.
func installedImage(t *testing.T) (*executableImage, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cxx")
	if err := os.WriteFile(path, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return &executableImage{path: path, running: info}, path
}

// replaceByRename installs new bytes the way `cxx update` does.
func replaceByRename(t *testing.T, path string) {
	t.Helper()
	tmp := path + ".new"
	if err := os.WriteFile(tmp, []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
}

func stubAgentsQuiet(t *testing.T, quiet bool) {
	t.Helper()
	previous := nativeAgentsQuiet
	nativeAgentsQuiet = func() bool { return quiet }
	t.Cleanup(func() { nativeAgentsQuiet = previous })
}

func TestExecutableImageDetectsAtomicReplacement(t *testing.T) {
	image, path := installedImage(t)
	if image.replaced() {
		t.Fatal("an untouched install reads as replaced")
	}
	replaceByRename(t, path)
	if !image.replaced() {
		t.Fatal("an install renamed over the start path was not detected")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if image.replaced() {
		t.Fatal("a missing path is not a replacement: nothing could start a successor from it")
	}
	var none *executableImage
	if none.replaced() {
		t.Fatal("an owner without a recorded image must never retire for it")
	}
}

func TestCurrentExecutableIsNotReplacedAtStart(t *testing.T) {
	image := currentExecutable()
	if image == nil {
		t.Fatal("the running test binary has no image")
	}
	if image.replaced() {
		t.Fatalf("the running image of %s reads as replaced", image.path)
	}
}

// The reported fault: the agent worker / host daemon lease keeps an updated
// owner on the deleted binary forever. A replaced, otherwise quiet owner must
// retire although a lease is still open.
func TestReplacedOwnerRetiresDespiteOpenLease(t *testing.T) {
	stubAgentsQuiet(t, true)
	image, path := installedImage(t)
	s := &server{lastUsed: time.Now(), leases: 2, calls: map[string]*sharedCall{}, image: image}
	_, served := serveUnderSupervision(t, s, 10*time.Millisecond, time.Hour)
	select {
	case err := <-served:
		t.Fatalf("an owner whose binary was not replaced stopped: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	replaceByRename(t, path)
	select {
	case err := <-served:
		if err != http.ErrServerClosed {
			t.Fatalf("unexpected serve result: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a replaced owner kept running for its leases")
	}
	if !s.draining.Load() || !s.terminating.Load() {
		t.Fatal("a retiring owner must close admission first")
	}
}

func TestReplacedOwnerWaitsForWorkAndAgents(t *testing.T) {
	cases := map[string]struct {
		quiet    bool
		prepare  func(*server)
		resident bool
	}{
		"request in flight": {quiet: true, prepare: func(s *server) { s.active = 1 }},
		"shared call":       {quiet: true, prepare: func(s *server) { s.calls["k"] = &sharedCall{} }},
		"sync worker":       {quiet: true, prepare: func(s *server) { s.syncCalls = map[string]*syncCall{"k": {}} }},
		"native agent":      {quiet: false, prepare: func(*server) {}},
		"resident":          {quiet: true, prepare: func(*server) {}, resident: true},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			stubAgentsQuiet(t, tc.quiet)
			image, path := installedImage(t)
			replaceByRename(t, path)
			s := &server{lastUsed: time.Now(), leases: 1, calls: map[string]*sharedCall{}, image: image}
			tc.prepare(s)
			s.resident.Store(tc.resident)
			_, served := serveUnderSupervision(t, s, 10*time.Millisecond, time.Hour)
			select {
			case err := <-served:
				t.Fatalf("owner retired while it must wait: %v", err)
			case <-time.After(200 * time.Millisecond):
			}
			if s.draining.Load() {
				t.Fatal("a waiting owner must keep admitting work")
			}
		})
	}
}

func TestStatusReportsReplacedExecutable(t *testing.T) {
	stubAgentsQuiet(t, false)
	image, path := installedImage(t)
	replaceByRename(t, path)
	s := &server{lastUsed: time.Now(), leases: 1, calls: map[string]*sharedCall{}, image: image}
	if s.retireIfReplaced(func() { t.Fatal("retired while an agent runs") }) {
		t.Fatal("retired while an agent runs")
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "http://communicator.local/_comm/status", nil))
	var status map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status["executable_replaced"] != true {
		t.Fatalf("status does not report the replaced executable: %s", rec.Body.String())
	}
}
