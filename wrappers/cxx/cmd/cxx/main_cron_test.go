package main

import "testing"

func TestParseHostCronDueIsOnlyAcceptedForRuns(t *testing.T) {
	tests := []struct {
		args    []string
		action  string
		minimal bool
		due     bool
		invalid bool
	}{
		{action: "run"},
		{args: []string{"run", "--due", "--minimal"}, action: "run", due: true, minimal: true},
		{args: []string{"--due"}, action: "run", due: true},
		{args: []string{"install", "--minimal-output"}, action: "install", minimal: true},
		{args: []string{"install", "--due"}, invalid: true},
		{args: []string{"remove", "--due"}, invalid: true},
		{args: []string{"run", "--force"}, invalid: true},
		{args: []string{"unknown"}, invalid: true},
	}
	for _, tc := range tests {
		action, minimal, due, err := parseHostCronArgs(tc.args)
		if (err != nil) != tc.invalid || (!tc.invalid && (action != tc.action || minimal != tc.minimal || due != tc.due)) {
			t.Fatalf("args=%q: action=%q minimal=%v due=%v err=%v", tc.args, action, minimal, due, err)
		}
	}
}
