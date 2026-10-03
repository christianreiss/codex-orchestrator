package codex

import (
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestDoctorShowsFleetSuspension(t *testing.T) {
	suspended := &config.Config{Host: config.Host{FleetDisabledEngines: []string{config.EngineCodex}}}
	for _, tc := range []struct {
		name   string
		cfg    *config.Config
		detail string
		want   bool
	}{
		{name: "server refuses with the fleet scope", cfg: &config.Config{}, detail: "auth=suspended", want: true},
		{name: "signed config while unreachable", cfg: suspended, detail: "auth probe failed: dial tcp: refused", want: true},
		{name: "server answered: switched back on", cfg: suspended, detail: "auth=valid", want: false},
		{name: "never suspended", cfg: &config.Config{}, detail: "no orchestrator response", want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			row, hint, got := engineSuspensionRow(tc.cfg, tc.detail)
			if got != tc.want {
				t.Fatalf("suspended=%v, want %v", got, tc.want)
			}
			if got && (row.Label != "Engine" || row.Value != "suspended (fleet)" || !strings.HasPrefix(hint, "Codex is disabled fleet-wide by the administrator.")) {
				t.Fatalf("row=%+v hint=%q", row, hint)
			}
		})
	}
}
