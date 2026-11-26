package summary

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/ui"
)

func codexPoolAuth(t *testing.T, used int, headroom bool, sibling string) *orchestrator.AuthRetrieveResponse {
	t.Helper()
	raw := `{"status":"valid","account_pool":true,"account_id":2,"quota_limit_percent":95,
	"quota_pool":{"policy":{"mode":"auto","strategy":"balanced"},"bound_account_id":2,"headroom":` + map[bool]string{true: "true", false: "false"}[headroom] + `,"live_switch":false,
	"recommendation":{"action":"continue","account_id":5,"message":"Account a is at 88%; pool: b ` + sibling + `%. Keep working; the next launch uses the pool policy."},
	"accounts":[{"id":2,"label":"a@example.com","state":"enabled","verified":true,"short_used_percent":10,"weekly_used_percent":88,"score":88},
	{"id":5,"label":"b@example.com","state":"enabled","verified":true,"short_used_percent":1,"weekly_used_percent":` + sibling + `,"score":` + sibling + `}]}}`
	var auth orchestrator.AuthRetrieveResponse
	if err := json.Unmarshal([]byte(raw), &auth); err != nil {
		t.Fatal(err)
	}
	auth.ChatGPT = &orchestrator.ChatGPTQuota{SecondaryUsed: &used}
	return &auth
}

func TestCodexPoolWithHeadroomListsAccountsWithoutWarning(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	got := Build(context.Background(), Inputs{WrapperVersion: "0.6.44", Auth: codexPoolAuth(t, 88, true, "20")})
	if got.QuotaWarn != "" || got.ResultTone != ui.ToneOK {
		t.Fatalf("healthy pool warned: warn=%q result=%q", got.QuotaWarn, got.ResultLabel)
	}
	if len(got.QuotaAccounts) != 2 || !got.QuotaAccounts[0].Bound || got.QuotaAccounts[0].Note != "in use" {
		t.Fatalf("rows = %+v", got.QuotaAccounts)
	}
	// Codex has no live switch: the server's message names the next launch.
	if !strings.Contains(got.QuotaNote, "Account pool: 2 accounts; policy auto/balanced; bound #2.") || !strings.Contains(got.QuotaNote, "the next launch uses the pool policy") {
		t.Fatalf("note = %q", got.QuotaNote)
	}
	var out bytes.Buffer
	ui.PrintMinimalScreen(&out, got)
	if !strings.Contains(out.String(), "account | id=5 | label=b@example.com | 5h=1% | 7d=20%") {
		t.Fatalf("minimal card:\n%s", out.String())
	}
}

func TestCodexPoolAnswerSurvivesTheCommunicatorRelay(t *testing.T) {
	raw, err := json.Marshal(codexPoolAuth(t, 88, false, "null"))
	if err != nil {
		t.Fatal(err)
	}
	var relayed orchestrator.AuthRetrieveResponse
	if err := json.Unmarshal(raw, &relayed); err != nil {
		t.Fatal(err)
	}
	q := relayed.QuotaPool
	if q == nil || q.Headroom == nil || *q.Headroom || q.Accounts[1].Score != nil || q.LiveSwitch || *q.BoundAccountID != 2 {
		t.Fatalf("relay lost pool fields: %s", raw)
	}
}

func TestCodexPoolStillBlocksAReachedLimit(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	auth := codexPoolAuth(t, 97, true, "20")
	auth.QuotaHardFail = true
	got := Build(context.Background(), Inputs{WrapperVersion: "0.6.44", Auth: auth})
	if got.QuotaBlock == "" || got.ResultTone != ui.ToneFail {
		t.Fatalf("this run stays on the exhausted account and must block: %+v", got)
	}
}

func TestCodexFullPoolKeepsTheWarning(t *testing.T) {
	withCodexVersion(t, "0.144.1")
	got := Build(context.Background(), Inputs{WrapperVersion: "0.6.44", Auth: codexPoolAuth(t, 88, false, "96")})
	if !strings.Contains(got.QuotaWarn, "quota high") || got.ResultTone != ui.ToneWarn || got.QuotaAccounts[1].Note != "at limit" {
		t.Fatalf("full pool: warn=%q rows=%+v", got.QuotaWarn, got.QuotaAccounts)
	}
}
