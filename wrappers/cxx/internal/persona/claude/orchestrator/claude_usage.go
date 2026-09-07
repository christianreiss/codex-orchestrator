package orchestrator

// ClaudeUsageSnapshot is the latest statusline report held by the fleet.
// Percent pointers preserve absent windows separately from measured zero.
// These are reported account windows; there are no ChatGPT/Spark lanes.
type ClaudeUsageSnapshot struct {
	Status           string `json:"status,omitempty"`
	Source           string `json:"source,omitempty"`
	FetchedAt        string `json:"fetched_at,omitempty"`
	FiveHourUsed     *int   `json:"five_hour_used_percent,omitempty"`
	FiveHourResetsAt string `json:"five_hour_resets_at,omitempty"`
	SevenDayUsed     *int   `json:"seven_day_used_percent,omitempty"`
	SevenDayResetsAt string `json:"seven_day_resets_at,omitempty"`
}
