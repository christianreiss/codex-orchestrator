package config

import "testing"

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
