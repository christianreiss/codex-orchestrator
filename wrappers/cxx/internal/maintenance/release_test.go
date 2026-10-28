package maintenance

import (
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/buildinfo"
)

// Feedback 3e2df8d1: a session started from a `go build` in a scratch directory
// queued background maintenance from that binary, and maintenance pointed the
// shared worker unit (and the user's crontab) at it. Only a versioned build
// queues automatic upkeep; test binaries never recurse into their runner.
func TestAutomaticMaintenanceRequiresAVersionedBuild(t *testing.T) {
	old := buildinfo.Version
	t.Cleanup(func() { buildinfo.Version = old })
	for _, tc := range []struct {
		version, exe string
		want         bool
	}{
		{"dev", "/tmp/scratch/cxx", false},
		{"", "/tmp/scratch/cxx", false},
		{"0.9.142", "/usr/local/bin/cxx", true},
		{"0.9.142", "/home/u/.local/bin/cxx", true},
		{"0.9.142", "/tmp/go-build/maintenance.test", false},
	} {
		buildinfo.Version = tc.version
		if got := automaticAllowed(tc.exe); got != tc.want {
			t.Fatalf("automaticAllowed(%q) with version %q = %v, want %v", tc.exe, tc.version, got, tc.want)
		}
	}
}
