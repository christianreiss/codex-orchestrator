package orchestrator

import (
	"encoding/json"
	"testing"
)

func TestProfilesFromRawReadsProfiles(t *testing.T) {
	got := profilesFromRaw(json.RawMessage(`{"status":"unchanged","profiles":[{"name":"fast","sha256":"abc","content":"model = \"gpt-6-luna\"\n"}]}`))
	if len(got) != 1 || got[0].Name != "fast" || got[0].SHA256 != "abc" {
		t.Fatalf("profiles = %+v", got)
	}
}

// Only a present list may prune, so an absent key and an empty list must differ.
func TestProfilesFromRawDistinguishesAbsentFromEmpty(t *testing.T) {
	for raw, wantNil := range map[string]bool{
		``:                                       true,
		`{"status":"unchanged"}`:                 true,
		`{"status":"unchanged","profiles":[]}`:   false,
		`{"status":"unchanged","profiles":null}`: true,
	} {
		if got := profilesFromRaw(json.RawMessage(raw)); (got == nil) != wantNil {
			t.Fatalf("%q: nil = %v, want %v", raw, got == nil, wantNil)
		}
	}
}
