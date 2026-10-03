package config

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestEngineDrift(t *testing.T) {
	cases := []struct {
		name          string
		local, remote []string
		want          bool
	}{
		{"equal", []string{"codex"}, []string{"codex"}, false},
		{"order and case", []string{"codex", "claude"}, []string{" Claude", "CODEX"}, false},
		{"engine added", []string{"codex"}, []string{"codex", "claude"}, true},
		{"engine removed", []string{"codex", "claude"}, []string{"claude"}, true},
		{"empty remote is not drift", []string{"codex"}, nil, false},
		{"blank legacy remote is not drift", []string{"codex"}, []string{""}, false},
	}
	for _, tc := range cases {
		if got := EngineDrift(tc.local, tc.remote); got != tc.want {
			t.Errorf("%s: EngineDrift(%v, %v) = %v, want %v", tc.name, tc.local, tc.remote, got, tc.want)
		}
	}
}

func TestEngineSuspendedDecodesSignedHostBlock(t *testing.T) {
	var cfg Config
	raw := []byte(`{"engine":"claude","host":{"id":7,"fqdn":"h","engines_list":["codex","claude"],"fleet_disabled_engines":[" Claude ","grok"]}}`)
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if !cfg.EngineSuspended(EngineClaude) || !cfg.EngineSuspended(EngineGrok) || cfg.EngineSuspended(EngineCodex) {
		t.Fatalf("suspension list misread: %q", cfg.Host.FleetDisabledEngines)
	}
	// Suspension is not removal: the assignment still names claude.
	if got := EnabledEngines(cfg.Host, cfg.Engine); len(got) != 2 {
		t.Fatalf("suspension leaked into the engine assignment: %q", got)
	}
	var none *Config
	if none.EngineSuspended(EngineCodex) {
		t.Fatal("nil config reported suspended")
	}
	var absent Config
	if err := json.Unmarshal([]byte(`{"host":{"id":1}}`), &absent); err != nil || absent.EngineSuspended(EngineCodex) || absent.Host.FleetDisabledEngines != nil {
		t.Fatalf("absent list must mean nothing suspended: %+v %v", absent.Host, err)
	}
	if out, _ := json.Marshal(absent.Host); strings.Contains(string(out), "fleet_disabled_engines") {
		t.Fatalf("empty suspension list must be omitted: %s", out)
	}
}

func TestSuspensionDriftAndRefusalTexts(t *testing.T) {
	cases := []struct {
		name          string
		local, remote []string
		want          bool
	}{
		{"both empty", nil, []string{}, false},
		{"same set any order", []string{"grok", "claude"}, []string{"CLAUDE", " grok"}, false},
		{"switched off", nil, []string{"claude"}, true},
		{"switched back on", []string{"claude"}, []string{}, true},
	}
	for _, tc := range cases {
		if got := SuspensionDrift(tc.local, tc.remote); got != tc.want {
			t.Errorf("%s: SuspensionDrift(%v, %v) = %v, want %v", tc.name, tc.local, tc.remote, got, tc.want)
		}
	}
	for engine, label := range map[string]string{EngineCodex: "Codex", EngineClaude: "Claude", EngineGrok: "Grok"} {
		if got, want := FleetDisabledMessage(engine), label+" is disabled fleet-wide by the administrator."; got != want {
			t.Errorf("FleetDisabledMessage(%s) = %q, want %q", engine, got, want)
		}
		if got, want := HostDisabledMessage(engine), label+" is disabled for this host by the administrator."; got != want {
			t.Errorf("HostDisabledMessage(%s) = %q, want %q", engine, got, want)
		}
		if EngineDisabledMessage(engine, "fleet") != FleetDisabledMessage(engine) ||
			EngineDisabledMessage(engine, "host") != HostDisabledMessage(engine) ||
			EngineDisabledMessage(engine, "") != HostDisabledMessage(engine) {
			t.Errorf("%s: a missing scope must keep its historical host meaning", engine)
		}
	}
}
