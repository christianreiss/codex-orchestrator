package accountpool

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// WeeklyUsage contains observations only, scoped to this fleet, native home and
// account. It never contains credentials or changes the account binding.
type WeeklyUsage struct {
	Engine    string `json:"engine"`
	AccountID int64  `json:"account_id"`
	Used      *int   `json:"used_percent,omitempty"`
	FetchedAt string `json:"fetched_at"`
	ResetAt   string `json:"reset_at"`
}

func (c *Context) cacheWeeklyLocked(doc map[string]json.RawMessage) {
	var engine string
	_ = json.Unmarshal(doc["engine"], &engine)
	if engine != "" && engine != c.Engine {
		return
	}
	var quota struct {
		Status           string `json:"status"`
		FetchedAt        string `json:"fetched_at"`
		PrimaryUsed      *int   `json:"primary_used_percent"`
		PrimarySeconds   int64  `json:"primary_limit_seconds"`
		PrimaryReset     string `json:"primary_reset_at"`
		SecondaryUsed    *int   `json:"secondary_used_percent"`
		SecondarySeconds int64  `json:"secondary_limit_seconds"`
		SecondaryReset   string `json:"secondary_reset_at"`
		SevenDayUsed     *int   `json:"seven_day_used_percent"`
		SevenDayReset    string `json:"seven_day_resets_at"`
	}
	field := "chatgpt"
	if c.Engine == "claude" {
		field = "claude_usage"
	} else if c.Engine != "codex" {
		return
	}
	decoded := json.Unmarshal(doc[field], &quota) == nil
	usage := WeeklyUsage{Engine: c.Engine, AccountID: c.AccountID, FetchedAt: quota.FetchedAt}
	if decoded && (quota.Status == "ok" || quota.Status == "success") {
		switch {
		case c.Engine == "claude":
			usage.Used, usage.ResetAt = quota.SevenDayUsed, quota.SevenDayReset
		case weeklySeconds(quota.PrimarySeconds):
			usage.Used, usage.ResetAt = quota.PrimaryUsed, quota.PrimaryReset
		case weeklySeconds(quota.SecondarySeconds):
			usage.Used, usage.ResetAt = quota.SecondaryUsed, quota.SecondaryReset
		}
	}
	raw, err := json.Marshal(usage)
	if err != nil {
		return
	}
	f, err := os.CreateTemp(filepath.Dir(c.path), ".weekly-usage-*")
	if err != nil {
		return
	}
	name := f.Name()
	defer os.Remove(name)
	_, err = f.Write(raw) // CreateTemp uses 0600, like the account binding.
	err = errors.Join(err, f.Close())
	if err == nil {
		_ = os.Rename(name, c.path+".weekly.json")
	}
}

// Weekly windows have occasionally included a minute of provider clock drift.
func weeklySeconds(seconds int64) bool { return seconds >= 604740 && seconds <= 604860 }

// CachedWeekly reads the last verified observation without a network call.
func (c *Context) CachedWeekly() *WeeklyUsage {
	c.mu.Lock()
	defer c.mu.Unlock()
	raw, err := os.ReadFile(c.path + ".weekly.json")
	if err != nil {
		return nil
	}
	var usage WeeklyUsage
	if json.Unmarshal(raw, &usage) != nil || usage.Engine != c.Engine || c.AccountID <= 0 || usage.AccountID != c.AccountID {
		return nil
	}
	return &usage
}
