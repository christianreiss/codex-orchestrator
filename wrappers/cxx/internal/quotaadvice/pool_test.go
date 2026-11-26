package quotaadvice

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func fptr(v float64) *float64 { return &v }
func iptr(v int64) *int64     { return &v }

// productionComparison mirrors the operator's report: Claude #1 at 87% weekly
// (forecast far past the limit), #8 freshly enrolled without a reading, and
// one Codex account at 20%. Without the pool the picker recommends Codex.
func productionComparison(headroom bool, siblingScore *float64) *Comparison {
	c := comparison()
	c.Claude = observation(87, 604800, 72*time.Hour)
	c.Codex = observation(20, 604800, 24*time.Hour)
	c.Claude.Pool = &Pool{
		BoundAccountID: iptr(1),
		Headroom:       headroom,
		Accounts: []PoolAccount{
			{ID: 1, Label: "email@christian-reiss.example", Usable: true, Score: fptr(87), ShortUsed: fptr(12), WeeklyUsed: fptr(87)},
			{ID: 8, Label: "christian.reiss@dalason.example", Usable: true, Score: siblingScore},
		},
	}
	return c
}

func TestPoolHeadroomKeepsTheEngineWithoutAPrompt(t *testing.T) {
	// Sanity: the bound account alone would trigger the recommendation.
	single := productionComparison(true, nil)
	single.Claude.Pool = nil
	if !Recommend(Evaluate(single.Claude, single.Settings, testNow), Evaluate(single.Codex, single.Settings, testNow), single.Settings) {
		t.Fatal("fixture must recommend Codex without a pool")
	}
	for _, mode := range []string{"ask", "hint"} {
		u, out := chooser(t, "")
		c := productionComparison(true, nil)
		c.Settings.Mode = mode
		got, err := u.Choose(context.Background(), c, "claude", false)
		if err != nil || got.Cancel || got.Engine != "claude" {
			t.Fatalf("%s: pool with headroom left Claude: %+v %v", mode, got, err)
		}
		if out.Len() != 0 {
			t.Fatalf("%s: pool with headroom printed advice:\n%s", mode, out)
		}
	}
}

func TestPoolHeadroomSurvivesTheBootstrapWireShape(t *testing.T) {
	// The launch reuses the /sync/bootstrap auth block, re-marshalled by the
	// communicator: the pool must decode from the server's JSON and survive.
	raw := []byte(`{"settings":{"mode":"ask","high_usage_percent":85,"projected_usage_percent":100,"min_pressure_gap":20,"max_age_minutes":30,"remember_day":true},
	"codex":{"available":true,"status":"ok","fetched_at":"` + testNow.Format(time.RFC3339) + `","limit_reached":false,"windows":[{"used_percent":20,"limit_seconds":604800,"reset_at":"` + testNow.Add(24*time.Hour).Format(time.RFC3339) + `"}]},
	"claude":{"available":true,"status":"ok","fetched_at":"` + testNow.Format(time.RFC3339) + `","limit_reached":false,"windows":[{"used_percent":12,"limit_seconds":18000,"reset_at":"` + testNow.Add(time.Hour).Format(time.RFC3339) + `"},{"used_percent":87,"limit_seconds":604800,"reset_at":"` + testNow.Add(72*time.Hour).Format(time.RFC3339) + `"}],
	"pool":{"bound_account_id":1,"launch_account_id":8,"headroom":true,"accounts":[{"id":1,"label":"a@example.com","usable":true,"score":87,"short_used_percent":12,"weekly_used_percent":87},{"id":8,"label":"b@example.com","usable":true,"score":null,"short_used_percent":null,"weekly_used_percent":null}]}}}`)
	var c Comparison
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	again, err := json.Marshal(&c)
	if err != nil {
		t.Fatal(err)
	}
	var relayed Comparison
	if err := json.Unmarshal(again, &relayed); err != nil {
		t.Fatal(err)
	}
	if !relayed.Claude.Pool.Multi() || !relayed.Claude.Pool.Headroom || relayed.Claude.Pool.Accounts[1].Score != nil {
		t.Fatalf("pool lost in relay: %+v", relayed.Claude.Pool)
	}
	u, out := chooser(t, "")
	got, err := u.Choose(context.Background(), &relayed, "claude", false)
	if err != nil || got.Engine != "claude" || out.Len() != 0 {
		t.Fatalf("relayed pool prompted: %+v %v %s", got, err, out)
	}
}

func TestFullPoolStillRecommendsAndListsTheAccounts(t *testing.T) {
	u, out := chooser(t, "")
	u.Interactive = false
	c := productionComparison(false, fptr(99))
	c.Claude.Pool.Accounts[1].ShortUsed, c.Claude.Pool.Accounts[1].WeeklyUsed = fptr(40), fptr(99)
	got, err := u.Choose(context.Background(), c, "claude", false)
	if err != nil || got.Engine != "claude" {
		t.Fatalf("%+v %v", got, err)
	}
	text := out.String()
	for _, want := range []string{"Recommend OpenAI (cdx)", "Claude (clx) pool:", "#1 email@christian-reiss.example 5h 12% 7d 87% (in use)", "#8 christian.reiss@dalason.example 5h 40% 7d 99%"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in:\n%s", want, text)
		}
	}
	// The interactive body lists the same pool under the engine bars.
	body := strings.Join(poolBody(terminalui.Caps{UTF8: true}, 100, namedPool{name: Name("claude"), pool: c.Claude.Pool}), "\n")
	for _, want := range []string{"Claude (clx) accounts", "#1 email@christian-reiss.ex", "in use", "99%"} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q in body:\n%s", want, body)
		}
	}
}

func TestNeverRecommendAnEngineWhoseWholePoolIsFull(t *testing.T) {
	u, out := chooser(t, "")
	c := productionComparison(false, fptr(99))
	c.Codex.Pool = &Pool{LaunchAccountID: iptr(3), Headroom: false, Accounts: []PoolAccount{
		{ID: 3, Label: "x", Usable: true, Score: fptr(97)}, {ID: 4, Label: "y", Usable: true, Score: fptr(98)},
	}}
	got, err := u.Choose(context.Background(), c, "claude", false)
	if err != nil || got.Engine != "claude" || out.Len() != 0 {
		t.Fatalf("full alternative pool recommended: %+v %v %s", got, err, out)
	}
}

func TestSingleAccountPoolKeepsTheExistingComparison(t *testing.T) {
	u, out := chooser(t, "")
	u.Interactive = false
	c := productionComparison(true, nil)
	c.Claude.Pool.Accounts = c.Claude.Pool.Accounts[:1]
	if _, err := u.Choose(context.Background(), c, "claude", false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Recommend OpenAI (cdx)") || strings.Contains(out.String(), "pool:") {
		t.Fatalf("single account must keep the old advice:\n%s", out)
	}
}
