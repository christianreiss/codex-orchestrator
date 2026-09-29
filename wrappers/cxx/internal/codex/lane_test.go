package codex

import (
	"reflect"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestApplyLanePreference(t *testing.T) {
	base := []string{"resume", "abc"}
	if got := ApplyLanePreference(base, "normal"); !reflect.DeepEqual(got, []string{"--model", "gpt-6-astra", "resume", "abc"}) {
		t.Fatalf("normal lane args = %v", got)
	}
	// The spark lane is retired: a stale preference launches no lane model.
	if got := ApplyLanePreference(base, "spark"); !reflect.DeepEqual(got, base) {
		t.Fatalf("retired spark lane changed args: %v", got)
	}
	for _, explicit := range [][]string{{"--model", "custom"}, {"--model=custom"}, {"-m", "custom"}, {"--profile", "work"}, {"-p", "work"}} {
		if got := ApplyLanePreference(explicit, "spark"); !reflect.DeepEqual(got, explicit) {
			t.Fatalf("explicit selection %v was overwritten: %v", explicit, got)
		}
	}
}

func TestAgentMessagingNeverInheritsDangerousBypass(t *testing.T) {
	cfg := &config.Config{EngineOptions: config.EngineOptions{DangerouslyBypassApprovalsAndSandbox: true}}
	base := []string{"exec", "-"}
	if got := applyDangerousBypass(cfg, base); !reflect.DeepEqual(got, []string{"--dangerously-bypass-approvals-and-sandbox", "exec", "-"}) {
		t.Fatalf("ordinary bypass args = %v", got)
	}
	t.Setenv("CXX_AGENT_MESSAGING_MESSAGE_ID", "11111111-1111-4111-8111-111111111111")
	if got := applyDangerousBypass(cfg, base); !reflect.DeepEqual(got, base) {
		t.Fatalf("peer delivery inherited dangerous bypass: %v", got)
	}
}

func TestModelContextMatchesLaunchSelection(t *testing.T) {
	if got := ModelContext(nil, "spark"); got != "" {
		t.Fatalf("retired spark context = %q", got)
	}
	if got := ModelContext(nil, "normal"); got != "gpt-6-astra" {
		t.Fatalf("normal context = %q", got)
	}
	if got := ModelContext([]string{"--profile", "work"}, "spark"); got != "profile:work" {
		t.Fatalf("profile context = %q", got)
	}
}

func TestEffortContextHonoursExplicitConfigOnly(t *testing.T) {
	if got := EffortContext(nil, "spark"); got != "" {
		t.Fatalf("retired spark lane injected effort %q", got)
	}
	if got := EffortContext([]string{"--profile", "work"}, "spark"); got != "" {
		t.Fatalf("profile effort was overwritten: %q", got)
	}
	if got := EffortContext([]string{"--config", "model_reasoning_effort=xhigh"}, "spark"); got != "xhigh" {
		t.Fatalf("explicit effort = %q, want xhigh", got)
	}
}

func TestEffectiveLaneMatchesHostContract(t *testing.T) {
	for _, tc := range []struct {
		preference string
		reported   string
		want       string
	}{
		{preference: "spark", reported: "normal", want: "normal"},
		{preference: "", reported: "spark", want: "normal"},
		{preference: "normal", reported: "", want: "normal"},
		{preference: "", reported: "", want: "normal"},
		{preference: "garbage", reported: "normal", want: "normal"},
	} {
		if got := EffectiveLane(tc.preference, tc.reported); got != tc.want {
			t.Fatalf("EffectiveLane(%q, %q) = %q, want %q", tc.preference, tc.reported, got, tc.want)
		}
	}
}
