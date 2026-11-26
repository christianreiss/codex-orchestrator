package agentbus

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Claude Code prints the reset of a usage limit in the user's time zone:
//
//	You've hit your session limit · resets 3pm (Europe/Berlin)
//	You've hit your weekly limit · resets Nov 28, 3:30pm (Europe/Berlin)
//	You've hit your limit · resets Jan 2, 2027, 9am (UTC)
//
// The clock time alone stands for a reset within 24 hours, the date form for a
// later one, and the year is printed only when it is not the current one.
var quotaResetPhrase = regexp.MustCompile(`(?i)\bresets(?: at)? (?:([a-z]{3}) (\d{1,2}), (?:(\d{4}), )?)?(\d{1,2})(?::(\d{2}))?\s?(am|pm) \(([A-Za-z0-9_+\-/]+)\)`)

// Older releases appended the reset as epoch seconds: "usage limit reached|1764342000".
var quotaResetEpoch = regexp.MustCompile(`(?i)limit reached\|(\d{10})\b`)

var quotaResetMonths = map[string]time.Month{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}

// quotaResetAt reads that reset as UTC RFC 3339. Anything it cannot place
// exactly (no zone, a zone this host does not know, a date without a time, a
// time that is not ahead) yields "": the server then uses the window it has on
// record. A wrong reset would hold an account back or retry it too early.
func quotaResetAt(text string, now time.Time) string {
	var latest time.Time
	keep := func(at time.Time, horizon time.Duration) {
		if at.After(now) && !at.After(now.Add(horizon)) && at.After(latest) {
			latest = at
		}
	}
	for _, m := range quotaResetEpoch.FindAllStringSubmatch(text, -1) {
		if seconds, err := strconv.ParseInt(m[1], 10, 64); err == nil {
			keep(time.Unix(seconds, 0), 31*24*time.Hour)
		}
	}
	for _, m := range quotaResetPhrase.FindAllStringSubmatch(text, -1) {
		if strings.EqualFold(m[7], "Local") {
			continue // The hook's own zone is not a zone the provider named.
		}
		loc, err := time.LoadLocation(m[7])
		if err != nil {
			continue
		}
		hour, _ := strconv.Atoi(m[4])
		minute := 0
		if m[5] != "" {
			minute, _ = strconv.Atoi(m[5])
		}
		if hour < 1 || hour > 12 || minute > 59 {
			continue
		}
		hour %= 12
		if strings.EqualFold(m[6], "pm") {
			hour += 12
		}
		local := now.In(loc)
		if m[1] == "" {
			// Clock time only: the next time the zone's clock shows it.
			at := time.Date(local.Year(), local.Month(), local.Day(), hour, minute, 0, 0, loc)
			if !at.After(now) {
				at = time.Date(local.Year(), local.Month(), local.Day()+1, hour, minute, 0, 0, loc)
			}
			keep(at, 24*time.Hour+5*time.Minute)
			continue
		}
		month, known := quotaResetMonths[strings.ToLower(m[1])]
		day, _ := strconv.Atoi(m[2])
		if !known || day < 1 || day > 31 {
			continue
		}
		year := local.Year()
		if m[3] != "" {
			year, _ = strconv.Atoi(m[3])
		}
		at := time.Date(year, month, day, hour, minute, 0, 0, loc)
		if at.Month() != month || at.Day() != day {
			continue // "Feb 30" is no date; Go would roll it into March.
		}
		keep(at, 31*24*time.Hour)
	}
	if latest.IsZero() {
		return ""
	}
	return latest.UTC().Format(time.RFC3339)
}
