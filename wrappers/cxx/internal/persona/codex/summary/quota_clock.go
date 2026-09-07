package summary

import (
	"strings"
	"time"
)

// quotaWindowClock keeps presentation time separate from observation time:
// stored reset_after_seconds belongs to fetched_at, while the countdown must
// decrease as that cached observation ages. Explicit reset_at takes priority.
func quotaWindowClock(fetched string, resetAfter *int64, resetAt string, limit *int64, now time.Time) (time.Duration, int64, bool, string) {
	observedAt, observedErr := time.Parse(time.RFC3339, strings.TrimSpace(fetched))
	var remaining time.Duration
	var observedRemaining int64
	known := false
	if strings.TrimSpace(resetAt) != "" {
		reset, err := time.Parse(time.RFC3339, strings.TrimSpace(resetAt))
		if err != nil {
			return 0, 0, true, "reset timestamp invalid"
		}
		remaining = reset.Sub(now)
		known = true
		if observedErr == nil {
			observedRemaining = int64(reset.Sub(observedAt) / time.Second)
		} else if resetAfter != nil {
			observedRemaining = *resetAfter
		}
	} else if resetAfter != nil {
		// Reject values that would overflow time.Duration before converting.
		if *resetAfter > int64((1<<63-1)/time.Second) {
			return 0, 0, true, "reset duration invalid"
		}
		if *resetAfter <= 0 {
			return 0, 0, true, "reset passed; awaiting report"
		}
		observedRemaining = *resetAfter
		remaining = time.Duration(*resetAfter) * time.Second
		known = true
		if observedErr == nil && now.After(observedAt) {
			remaining -= now.Sub(observedAt)
		}
	}
	if known && remaining <= 0 {
		return 0, 0, true, "reset passed; awaiting report"
	}
	if limit != nil && *limit > 0 && observedRemaining > *limit+60 {
		return 0, 0, true, "reset outside reported window"
	}
	if !known {
		return 0, 0, false, "reset unknown"
	}
	return remaining, observedRemaining, false, ""
}
