package nativeengine_test

import (
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeengine"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func TestMaintenanceTarget(t *testing.T) {
	store := nativeengine.Store{PinnedVersion: "2.5.3"}
	for _, tc := range []struct {
		name, action, installed, offered string
		exact                            bool
		want                             string
		wantErr                          bool
	}{
		{"no update preserves installed", "no_update", "2.7.2", "", false, "2.7.2", false},
		{"no update ignores lower target", "no_update", "2.7.2", "2.5.3", true, "2.7.2", false},
		{"missing CLI uses floor", "no_update", "", "", false, "2.5.3", false},
		{"unsupported CLI uses floor", "no_update", "2.4.9", "", false, "2.5.3", false},
		{"missing CLI uses fleet target", "update", "", "2.7.2", false, "2.7.2", false},
		{"exact tagged target", "update", "2.7.2", "v2.6.0", true, "2.6.0", false},
		{"tagged observed", "no_update", "v2.7.2", "", false, "2.7.2", false},
		{"invalid observed", "no_update", "02.7.2", "", false, "", true},
		{"double prefix", "update", "2.7.1", "vv2.7.2", false, "", true},
		{"abbreviated target", "update", "2.7.1", "v2.8", false, "", true},
		{"higher target", "update", "2.7.1", "2.7.2", false, "2.7.2", false},
		{"lower exact pin", "update", "2.7.2", "2.6.0", true, "2.6.0", false},
		{"lower nonexact target", "update", "2.7.2", "2.6.0", false, "2.7.2", false},
		{"lower nonexact prerelease", "update", "2.7.2-rc.10", "2.7.2-rc.2", false, "2.7.2-rc.10", false},
		{"higher prerelease", "update", "2.7.2-rc.2", "2.7.2-rc.10", false, "2.7.2-rc.10", false},
		{"below-floor exact pin", "update", "2.7.2", "2.5.2", true, "2.5.3", false},
		{"disabled installed CLI", "disable", "2.7.2", "2.6.0", true, "", false},
		{"disabled absent CLI", "disable", "", "2.7.2", false, "", false},
		{"missing update target", "update", "2.7.2", "", true, "", true},
		{"invalid update target", "update", "2.7.2", "latest", false, "", true},
		{"unknown action", "unknown", "2.7.2", "", false, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			check := &orchestrator.CronCheckResponse{Action: tc.action, TargetVersion: tc.offered, EnforceExact: tc.exact}
			got, err := nativeengine.MaintenanceTarget(check, tc.installed, store.CoerceVersionToMinimum)
			if got != tc.want || (err != nil) != tc.wantErr {
				t.Errorf("target = %q, err = %v, want %q, wantErr %t", got, err, tc.want, tc.wantErr)
			}
		})
	}
}
