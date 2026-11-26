package summary

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/poolview"
)

// bootstrapPoolAuth is the production shape of the /sync/bootstrap auth block
// a launch reuses after its lease: account #1 at 87% weekly with a forecast
// past the limit, #8 freshly enrolled without a reading.
func bootstrapPoolAuth(t *testing.T, headroom bool, siblingScore string) *orchestrator.AuthRetrieveResponse {
	t.Helper()
	now := time.Now().UTC()
	at := func(d time.Duration) string { return now.Add(d).Format(time.RFC3339) }
	raw := `{"status":"valid","account_pool":true,"account_id":1,"verification_state":"verified","quota_limit_percent":95,
	"claude_usage":{"status":"ok","fetched_at":"` + at(-4*time.Minute) + `","five_hour_used_percent":12,"five_hour_resets_at":"` + at(2*time.Hour) + `","seven_day_used_percent":87,"seven_day_resets_at":"` + at(72*time.Hour) + `"},
	"quota_pool":{"recommendation":{"action":"continue","account_id":null,"message":"Account email@christian-reiss.example is at 87%."},
	"policy":{"mode":"auto","strategy":"balanced"},"bound_account_id":1,"headroom":` + map[bool]string{true: "true", false: "false"}[headroom] + `,"launch_account_id":8,"live_switch":true,
	"accounts":[{"id":1,"label":"email@christian-reiss.example","state":"enabled","verified":true,"short_used_percent":12,"weekly_used_percent":87,"score":87,"fetched_at":"` + at(-4*time.Minute) + `"},
	{"id":8,"label":"christian.reiss@dalason.example","state":"enabled","verified":true,"short_used_percent":null,"weekly_used_percent":` + siblingScore + `,"score":` + siblingScore + `,"fetched_at":null}]}}`
	var auth orchestrator.AuthRetrieveResponse
	if err := json.Unmarshal([]byte(raw), &auth); err != nil {
		t.Fatal(err)
	}
	return &auth
}

func TestPoolWithHeadroomListsAccountsWithoutQuotaAttention(t *testing.T) {
	withClaudeVersion(t, "2.1.206")
	got := Build(context.Background(), Inputs{WrapperVersion: "1.0.0", Auth: bootstrapPoolAuth(t, true, "null")})
	if got.QuotaWarn != "" || got.ResultTone != ui.ToneOK || strings.Contains(got.ResultLabel, "quota") {
		t.Fatalf("one high account in a healthy pool raised attention: warn=%q result=%q/%s", got.QuotaWarn, got.ResultLabel, got.ResultTone)
	}
	for _, row := range got.QuotaRows {
		if row.ProjectionTone == ui.ToneWarn {
			t.Fatalf("forecast escalated despite pool headroom: %+v", row)
		}
		if row.Label == "weekly" && row.Projection == "" {
			t.Fatalf("forecast hidden instead of toned down: %+v", row)
		}
	}
	if len(got.QuotaAccounts) != 2 || !got.QuotaAccounts[0].Bound || got.QuotaAccounts[0].Note != "in use" || got.QuotaAccounts[1].Short != nil || got.QuotaAccounts[1].Weekly != nil {
		t.Fatalf("account rows = %+v", got.QuotaAccounts)
	}
	if !strings.Contains(got.QuotaNote, "Account pool: 2 accounts; policy auto/balanced; bound #1.") || !strings.Contains(got.QuotaNote, "keep working") {
		t.Fatalf("pool note = %q", got.QuotaNote)
	}
	var buf bytes.Buffer
	ui.PrintMinimalScreen(&buf, got)
	out := strings.NewReplacer("\n", " ").Replace(buf.String())
	for _, want := range []string{
		"account | id=1 | label=email@christian-reiss.example | 5h=12% | 7d=87% | bound=true | in use",
		"account | id=8 | label=christian.reiss@dalason.example | usage=none",
		"quota | Account pool: 2 accounts",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("minimal card misses %q:\n%s", want, buf.String())
		}
	}
	if strings.Contains(out, "warning |") {
		t.Fatalf("minimal card warns:\n%s", buf.String())
	}
}

func TestFullPoolKeepsTheQuotaWarning(t *testing.T) {
	withClaudeVersion(t, "2.1.206")
	got := Build(context.Background(), Inputs{WrapperVersion: "1.0.0", Auth: bootstrapPoolAuth(t, false, "99")})
	if !strings.Contains(got.QuotaWarn, "Claude weekly quota high") || got.ResultTone != ui.ToneWarn {
		t.Fatalf("full pool lost its warning: warn=%q result=%q", got.QuotaWarn, got.ResultLabel)
	}
	if len(got.QuotaAccounts) != 2 || got.QuotaAccounts[1].Note != "at limit" {
		t.Fatalf("account rows = %+v", got.QuotaAccounts)
	}
	if strings.Contains(got.QuotaNote, "keep working") {
		t.Fatalf("full pool told to keep working: %q", got.QuotaNote)
	}
}

func TestFreshlyBoundAccountWithoutReadingIsNotATelemetryFault(t *testing.T) {
	withClaudeVersion(t, "2.1.206")
	auth := bootstrapPoolAuth(t, true, "null")
	auth.AccountID = 8
	*auth.QuotaPool.BoundAccountID = 8
	auth.ClaudeUsage = &orchestrator.ClaudeUsageSnapshot{Status: "unavailable"}
	got := Build(context.Background(), Inputs{WrapperVersion: "1.0.0", Auth: auth})
	if got.QuotaWarn != "" || got.ResultTone != ui.ToneOK || !strings.HasPrefix(got.QuotaNote, "No usage reported yet for the bound account.") {
		t.Fatalf("fresh account: warn=%q note=%q result=%q", got.QuotaWarn, got.QuotaNote, got.ResultLabel)
	}
	if got.QuotaAccounts[1].Note != "in use" || got.QuotaAccounts[0].Bound {
		t.Fatalf("binding not reflected: %+v", got.QuotaAccounts)
	}
}

func TestStaleTelemetryStillWarnsInAPoolWithHeadroom(t *testing.T) {
	withClaudeVersion(t, "2.1.206")
	auth := bootstrapPoolAuth(t, true, "null")
	used := 40
	auth.ClaudeUsage = &orchestrator.ClaudeUsageSnapshot{Status: "unavailable", FetchedAt: time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339), FiveHourUsed: &used}
	got := Build(context.Background(), Inputs{WrapperVersion: "1.0.0", Auth: auth})
	if got.QuotaWarn == "" || strings.HasPrefix(got.QuotaNote, "No usage reported yet") {
		t.Fatalf("stale report hidden by the pool: warn=%q note=%q", got.QuotaWarn, got.QuotaNote)
	}
}

// emulatedPause is a fresh emulated 5h budget past its warning level.
func emulatedPause(t *testing.T, auth *orchestrator.AuthRetrieveResponse) {
	t.Helper()
	now := time.Now().UTC()
	raw := `{"emulation":{"enabled":true,"window_hours":5,"action":"suggest_pause"},"policy":{"short_warn_percent":80},
	"short":{"source":"emulated","used_percent":90,"limit_seconds":18000,"resets_at":"` + now.Add(time.Hour).Format(time.RFC3339) + `","observed_at":"` + now.Format(time.RFC3339) + `","status":"fresh","action":"suggest_pause"}}`
	if err := json.Unmarshal([]byte(raw), &auth.QuotaSnapshot); err != nil {
		t.Fatal(err)
	}
}

func TestEmulatedPauseYieldsOnlyToALiveSwitch(t *testing.T) {
	withClaudeVersion(t, "2.1.206")
	auth := bootstrapPoolAuth(t, true, "null")
	auth.QuotaPool.Recommendation = nil
	emulatedPause(t, auth)
	if got := Build(context.Background(), Inputs{WrapperVersion: "1.0.0", Auth: auth}); strings.Contains(got.QuotaWarn, "pause") {
		t.Fatalf("live switch with headroom still suggests a pause: %q", got.QuotaWarn)
	}
	auth.QuotaPool.LiveSwitch = false
	if got := Build(context.Background(), Inputs{WrapperVersion: "1.0.0", Auth: auth}); !strings.Contains(got.QuotaWarn, "suggest pause") {
		t.Fatalf("without a live switch the run stays on its account: %q", got.QuotaWarn)
	}
}

func TestPoolAnswerSurvivesTheCommunicatorRelay(t *testing.T) {
	auth := bootstrapPoolAuth(t, false, "null")
	raw, err := json.Marshal(auth)
	if err != nil {
		t.Fatal(err)
	}
	var relayed orchestrator.AuthRetrieveResponse
	if err := json.Unmarshal(raw, &relayed); err != nil {
		t.Fatal(err)
	}
	q := relayed.QuotaPool
	if q == nil || q.Headroom == nil || *q.Headroom || len(q.Accounts) != 2 || q.Accounts[1].Score != nil || *q.BoundAccountID != 1 || *q.LaunchAccountID != 8 || !q.LiveSwitch || q.Policy.Strategy != "balanced" {
		t.Fatalf("relay lost pool fields: %s", raw)
	}
	if strings.Contains(string(raw), `"account_switch"`) || strings.Contains(string(raw), `"binding_generation"`) {
		t.Fatalf("relay invented binding fields: %s", raw)
	}
}

func TestStatusPoolShowsBindingAndPendingSwitch(t *testing.T) {
	withClaudeVersion(t, "2.1.206")
	var view poolview.View
	raw := `{"engine":"claude","policy":{"mode":"manual","strategy":"balanced"},"bound_account_id":1,"binding_generation":3,
	"account_switch":{"account_id":8,"account_label":"christian.reiss@dalason.example","binding_generation":3,"reason":"host","requested_at":null},
	"live_switch":true,"accounts":[{"id":1,"label":"a@example.com","state":"enabled","verified":true,"short_used_percent":5,"weekly_used_percent":40,"score":40},
	{"id":8,"label":"christian.reiss@dalason.example","state":"enabled","verified":true,"short_used_percent":null,"weekly_used_percent":null,"score":null}],
	"recommendation":{"action":"continue","account_id":null,"message":"Account a@example.com is at 40%."}}`
	if err := json.Unmarshal([]byte(raw), &view); err != nil {
		t.Fatal(err)
	}
	got := Build(context.Background(), Inputs{WrapperVersion: "1.0.0", StatusOnly: true, Pool: poolview.FromView(&view, 0), Auth: bootstrapPoolAuth(t, true, "null")})
	if !got.QuotaAccounts[1].Target || got.QuotaAccounts[1].Note != "switching here" {
		t.Fatalf("pending target = %+v", got.QuotaAccounts[1])
	}
	for _, want := range []string{"policy manual", "bound #1 (generation 3)", "switch to #8 christian.reiss@dalason.example pending (host), at the next turn boundary"} {
		if !strings.Contains(got.QuotaNote, want) {
			t.Fatalf("status note misses %q: %q", want, got.QuotaNote)
		}
	}
}

func TestSingleAccountCardIsUnchanged(t *testing.T) {
	withClaudeVersion(t, "2.1.206")
	auth := bootstrapPoolAuth(t, true, "null")
	auth.QuotaPool = nil
	got := Build(context.Background(), Inputs{WrapperVersion: "1.0.0", Auth: auth})
	if len(got.QuotaAccounts) != 0 || got.QuotaNote != "" || !strings.Contains(got.QuotaWarn, "Claude weekly quota high (87% reported") {
		t.Fatalf("single account card changed: %+v", got)
	}
}
