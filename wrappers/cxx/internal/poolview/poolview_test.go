package poolview

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func f(v float64) *float64 { return &v }
func i(v int64) *int64     { return &v }
func b(v bool) *bool       { return &v }

func account(id int64, score *float64) Account {
	return Account{ID: id, Label: fmt.Sprintf("a%d@example.com", id), State: "enabled", Verified: true, Score: score, WeeklyUsedPercent: score}
}

func TestHeadroomMirrorsTheServerRule(t *testing.T) {
	balanced := &Policy{Mode: "auto", Strategy: "balanced", HardCeiling: 99}
	for _, c := range []struct {
		name     string
		state    State
		headroom bool
	}{
		{"server verdict wins", State{BoundID: 1, Headroom: b(false), Accounts: []Account{account(1, f(87)), account(8, nil)}}, false},
		{"unmeasured sibling counts as unused", State{BoundID: 1, Policy: balanced, Accounts: []Account{account(1, f(87)), account(8, nil)}}, true},
		{"sibling at the limit", State{BoundID: 1, Policy: balanced, Accounts: []Account{account(1, f(87)), account(8, f(95))}}, false},
		{"paused sibling", State{BoundID: 1, Accounts: []Account{account(1, f(87)), {ID: 8, State: "paused", Verified: true}}}, false},
		{"budget-blocked sibling", State{BoundID: 1, Accounts: []Account{account(1, f(87)), {ID: 8, State: "enabled", Verified: true, EmulationBlocked: true}}}, false},
		{"exhaust uses the hard ceiling", State{BoundID: 1, Policy: &Policy{Mode: "auto", Strategy: "exhaust", HardCeiling: 99}, Accounts: []Account{account(1, f(87)), account(8, f(97))}}, true},
		{"single account", State{BoundID: 1, Accounts: []Account{account(1, f(10))}}, false},
	} {
		if got := c.state.HasHeadroom(95); got != c.headroom {
			t.Fatalf("%s: headroom=%v", c.name, got)
		}
	}
}

func TestDoctorFlagsOnlyRealPoolProblems(t *testing.T) {
	policy := &Policy{Mode: "auto", Strategy: "balanced"}
	for _, c := range []struct {
		name  string
		state State
		tone  terminalui.Tone
		value string
	}{
		{"one high account in a healthy pool", State{Policy: policy, BoundID: 1, Generation: i(2), Accounts: []Account{account(1, f(87)), account(8, nil)}}, terminalui.ToneOK, "2 accounts, 2 usable; policy auto/balanced; bound #1 (generation 2)"},
		{"bound account paused", State{BoundID: 1, Accounts: []Account{{ID: 1, State: "paused", Verified: true}, account(8, nil)}}, terminalui.ToneWarn, "bound account #1 is paused"},
		{"bound account unverified", State{BoundID: 1, Accounts: []Account{{ID: 1, State: "enabled"}, account(8, nil)}}, terminalui.ToneWarn, "bound account #1 is unverified"},
		{"bound account removed", State{BoundID: 5, Accounts: []Account{account(1, nil), account(8, nil)}}, terminalui.ToneWarn, "bound account #5 is removed"},
		{"no usable account", State{Accounts: []Account{{ID: 1, State: "paused", Verified: true}, {ID: 8, State: "enabled"}}}, terminalui.ToneFail, "no usable account"},
		{"server says pause", State{BoundID: 1, Recommendation: &Recommendation{Action: "pause", Message: "all full"}, Accounts: []Account{account(1, f(99)), account(8, f(98))}}, terminalui.ToneWarn, "every account is at its limit"},
		{"whole pool at the limit without a session", State{BoundID: 1, Accounts: []Account{account(1, f(99)), account(8, f(98))}}, terminalui.ToneWarn, "every account is at its limit"},
		{"unbound scope", State{Accounts: []Account{account(1, f(40)), account(8, nil)}}, terminalui.ToneOK, "2 accounts, 2 usable"},
	} {
		got := c.state.Doctor(95, "clx accounts add")
		if got.Tone != c.tone || !strings.Contains(got.Value, c.value) {
			t.Fatalf("%s: %+v", c.name, got)
		}
	}
	if hint := (&State{Accounts: []Account{{ID: 1}, {ID: 2}}}).Doctor(95, "").Hint; strings.Contains(hint, "``") || hint == "" {
		t.Fatalf("hint without add command: %q", hint)
	}
}

func TestRowsAndNoteDescribeBindingAndPendingSwitch(t *testing.T) {
	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	old := now.Add(-3 * time.Hour).Format(time.RFC3339)
	s := State{
		Policy: &Policy{Mode: "manual"}, BoundID: 1, Generation: i(4), LiveSwitch: false,
		Pending:  &accountpool.SwitchDirective{AccountID: 8, AccountLabel: "b@example.com", Reason: "policy"},
		Accounts: []Account{account(1, f(96)), {ID: 8, Label: "b@example.com", State: "enabled", Verified: true, FetchedAt: &old, ShortUsedPercent: f(3)}, {ID: 9, Label: "c", State: "paused", Verified: true}},
	}
	rows := s.Rows(85, 95, now)
	if !rows[0].Bound || rows[0].Note != "in use, at limit" || rows[0].NoteTone != terminalui.ToneWarn {
		t.Fatalf("bound row = %+v", rows[0])
	}
	if !rows[1].Target || rows[1].Note != "switching here, reported 3h ago" || *rows[1].Short != 3 || rows[1].Weekly != nil {
		t.Fatalf("target row = %+v", rows[1])
	}
	if rows[2].Note != "paused" || rows[2].NoteTone != terminalui.ToneWarn {
		t.Fatalf("paused row = %+v", rows[2])
	}
	note := s.Note(95)
	if note != "Account pool: 3 accounts; policy manual; bound #1 (generation 4); switch to #8 b@example.com pending (policy), at the next launch. Another account has headroom; keep working." {
		t.Fatalf("note = %q", note)
	}
	// Unbound scope (codex before its first launch): the launch pick is named.
	unbound := State{LaunchID: 8, Accounts: []Account{account(1, f(50)), account(8, nil)}}
	if rows := unbound.Rows(85, 95, now); rows[1].Note != "next launch" || rows[0].Bound {
		t.Fatalf("unbound rows = %+v", rows)
	}
}

func TestNoteCarriesAPauseRecommendation(t *testing.T) {
	full := State{BoundID: 1, Recommendation: &Recommendation{Action: "pause", Message: "Account a is at 99%; every account in the pool is at its limit (b 98%)."},
		Accounts: []Account{account(1, f(99)), account(8, f(98))}}
	if note := full.Note(95); !strings.HasSuffix(note, "every account in the pool is at its limit (b 98%).") || strings.Contains(note, "keep working") {
		t.Fatalf("note = %q", note)
	}
	if v := full.Doctor(95, "").Value; !strings.Contains(v, "#1 99%, #8 98%") {
		t.Fatalf("doctor usage = %q", v)
	}
	if v := (&State{Accounts: []Account{account(1, f(87)), {ID: 8, State: "enabled", Verified: true, ShortUsedPercent: f(3)}, account(9, nil)}}).Doctor(95, "").Value; !strings.Contains(v, "#1 87%, #8 3%, #9 no reading") {
		t.Fatalf("doctor usage = %q", v)
	}
}

func TestQuotaPoolDecodesTheServerShape(t *testing.T) {
	var q QuotaPool
	raw := `{"recommendation":{"action":"continue","account_id":8,"message":"m"},"policy":{"mode":"auto","strategy":"balanced"},"bound_account_id":1,"headroom":true,"launch_account_id":8,"live_switch":true,
	"accounts":[{"id":1,"label":"a","state":"enabled","verified":true,"short_used_percent":12,"short_resets_at":"x","weekly_used_percent":87,"weekly_resets_at":"y","fetched_at":"z","score":87,"emulation_blocked":false,"plan":"Max"}]}`
	if err := json.Unmarshal([]byte(raw), &q); err != nil {
		t.Fatal(err)
	}
	s := FromQuotaPool(&q, 0, nil, nil)
	if s.BoundID != 1 || s.LaunchID != 8 || !*s.Headroom || !s.LiveSwitch || *s.Accounts[0].Score != 87 {
		t.Fatalf("state = %+v", s)
	}
	if FromQuotaPool(&QuotaPool{}, 3, nil, nil).BoundID != 3 {
		t.Fatal("older server: bound falls back to the answer's account_id")
	}
}

type fakeClient struct {
	paths []string
	reply func(path string) (string, error)
}

type notFoundErr struct{}

func (notFoundErr) Error() string   { return "not found" }
func (notFoundErr) HTTPStatus() int { return http.StatusNotFound }

func (c *fakeClient) JSON(_ context.Context, _ string, path string, _ any, out any, _ int) error {
	c.paths = append(c.paths, path)
	body, err := c.reply(path)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(body), out)
}

func TestFetchFallsBackToTheScopeWithoutSession(t *testing.T) {
	t.Setenv("CXX_PROVIDER_SESSION_ID", "deadbeef00")
	pool := accountpool.Load("claude", filepath.Join(t.TempDir(), ".credentials.json"), "https://orchestrator.example")
	client := &fakeClient{reply: func(path string) (string, error) {
		if strings.Contains(path, "session_id=") {
			return "", notFoundErr{}
		}
		return `{"engine":"claude","bound_account_id":null,"accounts":[{"id":1,"state":"enabled","verified":true},{"id":2,"state":"enabled","verified":true}]}`, nil
	}}
	view, raw, err := Fetch(context.Background(), client, pool, "claude")
	if err != nil || len(view.Accounts) != 2 || len(raw) == 0 {
		t.Fatalf("fetch: %+v %v", view, err)
	}
	if len(client.paths) != 2 || !strings.Contains(client.paths[0], "session_id=deadbeef00") || strings.Contains(client.paths[1], "session_id") {
		t.Fatalf("paths = %v", client.paths)
	}
	row, _, ok := DoctorRow(context.Background(), client, pool, "claude", nil, "clx accounts add")
	if !ok || row.Label != "Accounts" || row.Tone != terminalui.ToneOK {
		t.Fatalf("doctor row = %+v %v", row, ok)
	}
	failing := &fakeClient{reply: func(string) (string, error) { return "", fmt.Errorf("boom") }}
	if _, _, ok := DoctorRow(context.Background(), failing, pool, "claude", nil, ""); ok {
		t.Fatal("unreadable pool must not add a row")
	}
}
