package grok

import (
	"errors"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grokreap"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func TestDoctorReportsLeftoversWithoutReaping(t *testing.T) {
	previous := leftoverPreview
	t.Cleanup(func() { leftoverPreview = previous })
	for _, tc := range []struct {
		name  string
		r     grokreap.Result
		err   error
		tone  terminalui.Tone
		value string
	}{
		{"clean", grokreap.Result{DryRun: true}, nil, terminalui.ToneOK, "none"},
		{"orphans warn", grokreap.Result{DryRun: true, Items: []grokreap.Item{{Kind: "leader", Action: "would_reap"}, {Kind: "log", Action: "would_remove"}}}, nil, terminalui.ToneWarn, "1 orphaned leader(s), 0 stale runtime dir(s), 1 old leader log(s)"},
		{"old logs alone are routine", grokreap.Result{DryRun: true, Items: []grokreap.Item{{Kind: "log", Action: "would_remove"}}}, nil, terminalui.ToneOK, "0 orphaned leader(s)"},
		{"unsupported platform", grokreap.Result{}, grokreap.ErrUnsupported, terminalui.ToneOK, "not inspected"},
		{"failure", grokreap.Result{}, errors.New("proc unreadable"), terminalui.ToneWarn, "inspection failed: proc unreadable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			leftoverPreview = func() (grokreap.Result, error) { return tc.r, tc.err }
			label, tone, value := leftoversCheck()
			if label != "Leftovers" || tone != tc.tone || !strings.Contains(value, tc.value) {
				t.Fatalf("%s %v %q", label, tone, value)
			}
		})
	}
}
