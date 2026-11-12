package accountpool

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWeeklyCacheUsesWindowDurationAndOwnEngine(t *testing.T) {
	for _, tc := range []struct {
		engine, quota string
		used          int
	}{
		{"codex", `"chatgpt":{"status":"ok","fetched_at":"2026-10-12T12:00:00Z","primary_used_percent":0,"primary_limit_seconds":604800,"secondary_used_percent":95,"secondary_limit_seconds":18000}`, 0},
		{"codex", `"chatgpt":{"status":"ok","fetched_at":"2026-10-12T12:00:00Z","primary_used_percent":95,"primary_limit_seconds":18000,"secondary_used_percent":42,"secondary_limit_seconds":604860}`, 42},
		{"claude", `"claude_usage":{"status":"ok","fetched_at":"2026-10-12T12:00:00Z","five_hour_used_percent":95,"seven_day_used_percent":24}`, 24},
	} {
		c := Load(tc.engine, filepath.Join(t.TempDir(), "auth.json"), "https://fleet.example")
		body := `{"verification_state":"verified","account_id":7,"auth":{"token":"must-not-be-cached"},` + tc.quota + `}`
		c.Observe("/auth", []byte(body))
		q := c.CachedWeekly()
		if q == nil || q.Used == nil || *q.Used != tc.used || q.AccountID != 7 {
			t.Fatalf("%s cache = %+v", tc.engine, q)
		}
		raw, err := os.ReadFile(c.path + ".weekly.json")
		if err != nil || strings.Contains(string(raw), "must-not-be-cached") || strings.Contains(string(raw), `"auth"`) {
			t.Fatalf("usage cache contains non-observation data: %s %v", raw, err)
		}
		info, _ := os.Stat(c.path + ".weekly.json")
		if info.Mode().Perm() != 0o600 {
			t.Fatal("usage cache permissions", info.Mode())
		}
	}
}

func TestWeeklyCacheRequiresVerifiedAccountAndPreservesScope(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.json")
	c := Load("codex", path, "https://fleet.example")
	quota := `"chatgpt":{"status":"ok","fetched_at":"2026-10-12T12:00:00Z","primary_used_percent":42,"primary_limit_seconds":604800}`
	c.Observe("/auth", []byte(`{"account_id":7,"verification_state":"pending",`+quota+`}`))
	if c.CachedWeekly() != nil {
		t.Fatal("unverified account cached")
	}
	c.Observe("/sync/bootstrap", []byte(`{"data":{"auth":{"account_id":7,"verification_state":"verified",`+quota+`}}}`))
	if Load("codex", path, "https://fleet.example").CachedWeekly() == nil {
		t.Fatal("bootstrap observation not persisted")
	}
	if Load("codex", path, "https://other.example").CachedWeekly() != nil {
		t.Fatal("cache crossed fleets")
	}
	if Load("claude", path, "https://fleet.example").CachedWeekly() != nil {
		t.Fatal("cache crossed engines")
	}
	c.AccountID = 8
	if c.CachedWeekly() != nil {
		t.Fatal("cache crossed accounts")
	}
	c.Observe("/auth", []byte(`{"account_id":8,"verification_state":"verified","chatgpt":{"status":"unavailable"}}`))
	if q := c.CachedWeekly(); q == nil || q.Used != nil {
		t.Fatal("unavailable snapshot retained old usage", q)
	}
}

func TestKimiWeeklyCacheUsesServerShapes(t *testing.T) {
	for _, fixture := range []string{"server-usage.json", "server-lease.json"} {
		t.Run(fixture, func(t *testing.T) {
			raw, err := os.ReadFile("../kimi/testdata/" + fixture)
			if err != nil {
				t.Fatal(err)
			}
			var doc map[string]json.RawMessage
			if err := json.Unmarshal(raw, &doc); err != nil {
				t.Fatal(err)
			}
			doc["account_id"] = json.RawMessage(`7`)
			doc["verification_state"] = json.RawMessage(`"verified"`)
			body, _ := json.Marshal(doc)
			c := Load("kimi", filepath.Join(t.TempDir(), "auth.json"), "https://fleet.example")
			c.Observe("/auth", body)
			got := c.CachedWeekly()
			if got == nil || got.Used == nil || *got.Used != 62 || got.ResetAt != "2099-01-08T00:00:00.000Z" || got.FetchedAt != "2099-01-01T00:00:00.000Z" {
				t.Fatalf("server weekly reading lost: %+v", got)
			}
		})
	}
}
