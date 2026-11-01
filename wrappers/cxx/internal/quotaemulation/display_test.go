package quotaemulation

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestEmulatedDisplay(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	for _, action := range []string{"suggest_pause", "suggest_ignore", "hard_stop"} {
		var s Snapshot
		raw := `{"emulation":{"enabled":true},"policy":{"short_warn_percent":85},"short":{"source":"emulated","used_percent":110,"limit_seconds":28800,"resets_at":"2026-11-01T13:00:00Z","observed_at":"2026-11-01T12:00:00Z","status":"fresh","action":"` + action + `"}}`
		if err := json.Unmarshal([]byte(raw), &s); err != nil {
			t.Fatal(err)
		}
		rows, note := Display(&s, now)
		if len(rows) != 1 || rows[0].Label != "emulated 8h" || rows[0].Used != 110 || rows[0].Stale || note == "" {
			t.Fatalf("%s: %+v %q", action, rows, note)
		}
		if action == "suggest_ignore" && !strings.Contains(note, "suggest ignore") {
			t.Fatal(note)
		}
		if action == "hard_stop" && rows[0].BlockAtPct != 100 {
			t.Fatal(rows)
		}
		rows, note = Display(&s, now.Add(11*time.Minute))
		if !rows[0].Stale || !strings.Contains(note, "work allowed") {
			t.Fatalf("stale %+v %q", rows, note)
		}
		s.Unlimited = true
		if rows, note = Display(&s, now); len(rows) != 0 || note != "" {
			t.Fatal("unlimited")
		}
	}
}
func TestAbsentAndNativeWindows(t *testing.T) {
	var s Snapshot
	if rows, note := Display(&s, time.Now()); len(rows) != 0 || note != "" {
		t.Fatal("off")
	}
	s.Emulation.Enabled = true
	if _, note := Display(&s, time.Now()); !strings.Contains(note, "unavailable") {
		t.Fatal(note)
	}
	if err := json.Unmarshal([]byte(`{"emulation":{"enabled":true},"short":{"source":"chatgpt_usage","used_percent":0}}`), &s); err != nil {
		t.Fatal(err)
	}
	if rows, note := Display(&s, time.Now()); len(rows) != 0 || note != "" {
		t.Fatal("native window")
	}
}
