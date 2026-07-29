package codex

import (
	"reflect"
	"testing"
)

func TestApplyLanePreference(t *testing.T) {
	base := []string{"resume", "abc"}
	if got := ApplyLanePreference(base, "normal"); !reflect.DeepEqual(got, []string{"--model", "gpt-5.6-terra", "resume", "abc"}) {
		t.Fatalf("normal lane args = %v", got)
	}
	spark := ApplyLanePreference(base, "spark")
	wantSpark := []string{"--model", "gpt-5.3-codex-spark", "--config", "model_reasoning_effort=high", "--config", "model_reasoning_summary=none", "resume", "abc"}
	if !reflect.DeepEqual(spark, wantSpark) {
		t.Fatalf("spark lane args = %v, want %v", spark, wantSpark)
	}
	for _, explicit := range [][]string{{"--model", "custom"}, {"--model=custom"}, {"-m", "custom"}, {"--profile", "work"}, {"-p", "work"}} {
		if got := ApplyLanePreference(explicit, "spark"); !reflect.DeepEqual(got, explicit) {
			t.Fatalf("explicit selection %v was overwritten: %v", explicit, got)
		}
	}
}

func TestModelContextMatchesLaunchSelection(t *testing.T) {
	if got := ModelContext(nil, "spark"); got != "gpt-5.3-codex-spark" {
		t.Fatalf("spark context = %q", got)
	}
	if got := ModelContext([]string{"--profile", "work"}, "spark"); got != "profile:work" {
		t.Fatalf("profile context = %q", got)
	}
}

func TestEffortContextMatchesSparkInjection(t *testing.T) {
	if got := EffortContext(nil, "spark"); got != "high" {
		t.Fatalf("spark effort = %q, want high", got)
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
		{preference: "spark", reported: "normal", want: "spark"},
		{preference: "", reported: "spark", want: "spark"},
		{preference: "", reported: "", want: "normal"},
		{preference: "garbage", reported: "normal", want: "normal"},
	} {
		if got := EffectiveLane(tc.preference, tc.reported); got != tc.want {
			t.Fatalf("EffectiveLane(%q, %q) = %q, want %q", tc.preference, tc.reported, got, tc.want)
		}
	}
}
