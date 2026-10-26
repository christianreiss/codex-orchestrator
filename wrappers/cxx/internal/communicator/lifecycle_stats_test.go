package communicator

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLifecycleStatsReportActualOwnerAndCurrentClientCounts(t *testing.T) {
	dir, err := os.MkdirTemp("", "cxs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	var clients atomic.Int64
	clients.Store(3)
	socket := ownerSocket(t, dir, "status.sock", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/_comm/status" {
			t.Errorf("statistics attempted %s %s", r.Method, r.URL.Path)
		}
		fmt.Fprintf(w, `{"version":"test","pid":42,"owner_instance_id":"one","sessions":%d}`, clients.Load())
	})
	for _, tc := range []struct{ started, runtimeOnly bool }{{}, {started: true}, {runtimeOnly: true}} {
		t.Run(fmt.Sprint(tc), func(t *testing.T) {
			base := "https://lifecycle-stats.example"
			ep := &endpoint{base: base, socket: socket, runtimeOnly: tc.runtimeOnly, startedPIDs: map[int]struct{}{99: {}}}
			if tc.started {
				ep.startedPIDs[42] = struct{}{}
			}
			registry.Store(base, ep)
			t.Cleanup(func() { registry.Delete(base) })
			stats := NewLifecycleStats(base)
			clients.Store(3)
			state := "already running"
			if tc.started {
				state = "started for this session"
			}
			if got, want := stats.Start(), "start: "+state+" | pid=42 | clients=3"; got != want {
				t.Fatalf("start=%q, want %q", got, want)
			}
			clients.Store(1)
			if got := stats.End(); got != "end: running | pid=42 | clients=1" {
				t.Fatal(got)
			}
		})
	}
}

func TestLifecycleStatsExposeOwnerReplacementAndMissingCounts(t *testing.T) {
	dir, err := os.MkdirTemp("", "cxs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	var body atomic.Value
	body.Store(`{"version":"old","pid":42,"owner_instance_id":"one","sessions":0}`)
	socket := ownerSocket(t, dir, "status.sock", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, body.Load()) })
	base := "https://lifecycle-replacement.example"
	registry.Store(base, &endpoint{base: base, socket: socket})
	t.Cleanup(func() { registry.Delete(base) })
	stats := NewLifecycleStats(base)
	if got := stats.Start(); !strings.HasSuffix(got, "clients=0") {
		t.Fatal(got)
	}
	// Same PID with a different owner instance must still be identified.
	body.Store(`{"version":"new","pid":42,"owner_instance_id":"two"}`)
	if got := stats.End(); got != "end: owner changed | pid=42 | clients=unknown" {
		t.Fatal(got)
	}
	registry.Store(base, &endpoint{base: base, socket: filepath.Join(dir, "missing.sock")})
	if got := stats.End(); got != "end: unavailable | clients=unknown" {
		t.Fatal(got)
	}
	if _, err := os.Stat(filepath.Join(dir, "missing.sock")); !os.IsNotExist(err) {
		t.Fatal("statistics started an owner")
	}
	if got := NewLifecycleStats("https://not-configured.example").Start(); got != "start: not configured" {
		t.Fatal(got)
	}
}

func TestLifecycleStatsBoundAnUnresponsiveOwner(t *testing.T) {
	dir, err := os.MkdirTemp("", "cxs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := ownerSocket(t, dir, "slow.sock", func(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
	base := "https://lifecycle-slow.example"
	registry.Store(base, &endpoint{base: base, socket: socket})
	t.Cleanup(func() { registry.Delete(base) })
	started := time.Now()
	if got := NewLifecycleStats(base).End(); got != "end: unavailable | clients=unknown" {
		t.Fatal(got)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("exit statistics blocked for %s", elapsed)
	}
}
