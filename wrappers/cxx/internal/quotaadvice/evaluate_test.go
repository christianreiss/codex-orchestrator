package quotaadvice

import (
	"encoding/json"
	"testing"
	"time"
)

func ptr(n int) *int { return &n }
func defaults() Settings {
	return Settings{Mode: "ask", HighUsage: 85, ProjectedUsage: 100, MinGap: 20, MaxAgeMinutes: 30, RememberDay: true}
}

var testNow = time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)

func observation(used int, seconds int64, remaining time.Duration) Snapshot {
	return Snapshot{Available: true, Status: "ok", FetchedAt: testNow.Format(time.RFC3339), Windows: []Window{{Used: ptr(used), Seconds: seconds, ResetAt: testNow.Add(remaining).Format(time.RFC3339)}}}
}
func comparison() *Comparison {
	return &Comparison{Settings: defaults(), Codex: observation(90, 18000, time.Hour), Claude: observation(20, 604800, 24*time.Hour)}
}
func TestRecommendBothDirections(t *testing.T) {
	c := comparison()
	a := Evaluate(c.Codex, c.Settings, testNow)
	b := Evaluate(c.Claude, c.Settings, testNow)
	if !Recommend(a, b, c.Settings) || Recommend(b, a, c.Settings) {
		t.Fatalf("wrong direction: %+v %+v", a, b)
	}
	c.Codex, c.Claude = c.Claude, c.Codex
	if !Recommend(Evaluate(c.Claude, c.Settings, testNow), Evaluate(c.Codex, c.Settings, testNow), c.Settings) {
		t.Fatal("reverse direction missing")
	}
}
func TestProjectionUsesObservationTime(t *testing.T) {
	s := observation(60, 18000, 3*time.Hour)
	cfg := defaults()
	before := Evaluate(s, cfg, testNow)
	after := Evaluate(s, cfg, testNow.Add(20*time.Minute))
	if before.Projected != 150 || before.Score != after.Score {
		t.Fatalf("cached quota changed burn rate: %+v %+v", before, after)
	}
	// Near reset, 84% is below both thresholds, unlike 60% two hours into a five-hour window.
	near := Evaluate(observation(84, 18000, time.Minute), cfg, testNow)
	if near.Score >= 100 || before.Score < 100 {
		t.Fatal("reset time not reflected")
	}
	early := Evaluate(observation(1, 18000, 5*time.Hour-time.Minute), cfg, testNow)
	if early.Projected != 0 {
		t.Fatal("first sample projected")
	}
}
func TestInvalidEvidenceNeverRecommends(t *testing.T) {
	cases := map[string]func(*Snapshot){
		"stale":           func(s *Snapshot) { s.FetchedAt = testNow.Add(-31 * time.Minute).Format(time.RFC3339) },
		"future":          func(s *Snapshot) { s.FetchedAt = testNow.Add(2 * time.Minute).Format(time.RFC3339) },
		"missing time":    func(s *Snapshot) { s.FetchedAt = "" },
		"reset passed":    func(s *Snapshot) { s.Windows[0].ResetAt = testNow.Format(time.RFC3339) },
		"invalid reset":   func(s *Snapshot) { s.Windows[0].ResetAt = testNow.Add(8 * time.Hour).Format(time.RFC3339) },
		"invalid percent": func(s *Snapshot) { s.Windows[0].Used = ptr(-1) },
		"missing window":  func(s *Snapshot) { s.Windows[0].Used = nil },
		"unavailable":     func(s *Snapshot) { s.Status = "unavailable" },
		"not configured":  func(s *Snapshot) { s.Available = false },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			s := observation(90, 18000, time.Hour)
			mutate(&s)
			p := Evaluate(s, defaults(), testNow)
			if p.Valid || Recommend(p, Pressure{Valid: true}, defaults()) {
				t.Fatalf("invalid evidence allowed: %+v", p)
			}
		})
	}
}
func TestWindowsAndThresholds(t *testing.T) {
	s := observation(0, 18000, time.Hour)
	s.Windows = append(s.Windows, Window{Used: ptr(95), Seconds: 604800, ResetAt: testNow.Add(time.Hour).Format(time.RFC3339)})
	p := Evaluate(s, defaults(), testNow)
	if !p.Valid || p.Used != 95 || p.WindowSeconds != 604800 {
		t.Fatalf("worst window: %+v", p)
	}
	cfg := defaults()
	if Recommend(Pressure{Valid: true, Score: 100}, Pressure{Valid: true, Score: 81}, cfg) || !Recommend(Pressure{Valid: true, Score: 100}, Pressure{Valid: true, Score: 80}, cfg) || Recommend(Pressure{Valid: true, Score: 130}, Pressure{Valid: true, Score: 100}, cfg) {
		t.Fatal("gap/both stressed boundary")
	}
	zero := Evaluate(observation(0, 18000, time.Hour), cfg, testNow)
	if !zero.Valid || zero.Used != 0 {
		t.Fatal("zero lost")
	}
}
func TestWireNullAndProviderLimit(t *testing.T) {
	var s Snapshot
	if err := json.Unmarshal([]byte(`{"available":true,"status":"ok","fetched_at":"2026-09-14T12:00:00Z","limit_reached":true,"windows":[{"used_percent":0,"limit_seconds":null,"reset_at":null},{"used_percent":null}]}`), &s); err != nil {
		t.Fatal(err)
	}
	p := Evaluate(s, defaults(), testNow)
	if !p.Valid || p.Score < 100 || p.Projected != 0 {
		t.Fatalf("provider limit/unknown reset: %+v", p)
	}
}
