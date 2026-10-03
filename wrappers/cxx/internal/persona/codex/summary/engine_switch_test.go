package summary

import (
	"context"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/ui"
)

func TestStatusShowsFleetSuspension(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const want = "suspended (fleet): Codex is disabled fleet-wide by the administrator."
	suspended := &config.Config{Host: config.Host{FQDN: "h", Secure: true, FleetDisabledEngines: []string{config.EngineCodex}}}
	enabled := &config.Config{Host: config.Host{FQDN: "h", Secure: true}}
	for _, tc := range []struct {
		name string
		cfg  *config.Config
		auth *orchestrator.AuthRetrieveResponse
		want string
	}{
		{name: "server refuses with the fleet scope", cfg: enabled, auth: &orchestrator.AuthRetrieveResponse{Status: orchestrator.AuthStatusSuspended}, want: want},
		{name: "signed config while the API is unreachable", cfg: suspended, auth: nil, want: want},
		{name: "signed config while offline", cfg: suspended, auth: &orchestrator.AuthRetrieveResponse{Status: "offline"}, want: want},
		{name: "server answered: switched back on", cfg: suspended, auth: &orchestrator.AuthRetrieveResponse{Status: "valid"}, want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := Build(context.Background(), Inputs{Config: tc.cfg, Auth: tc.auth, StatusOnly: true, SkipVersionProbe: true})
			if tc.want == "" {
				if state.ResultLabel == want {
					t.Fatalf("a re-enabled engine still reads suspended")
				}
				return
			}
			if state.ResultLabel != tc.want || state.ResultTone != ui.ToneFail {
				t.Fatalf("result = %q (%v), want %q", state.ResultLabel, state.ResultTone, tc.want)
			}
		})
	}
}
