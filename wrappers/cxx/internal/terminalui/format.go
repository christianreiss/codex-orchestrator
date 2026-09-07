package terminalui

import (
	"fmt"
	"strconv"
	"time"
)

// CompactNumber renders large integers as "12K", "1.5M", "10M".
func CompactNumber(n int64) string {
	switch {
	case n >= 10_000_000 || n <= -10_000_000:
		return fmt.Sprintf("%dM", n/1_000_000)
	case n >= 1_000_000 || n <= -1_000_000:
		v := float64(n) / 1_000_000
		if v == float64(int(v)) {
			return fmt.Sprintf("%dM", int(v))
		}
		return fmt.Sprintf("%.1fM", v)
	case n >= 10_000 || n <= -10_000:
		return fmt.Sprintf("%dK", n/1_000)
	case n >= 1_000 || n <= -1_000:
		v := float64(n) / 1_000
		if v == float64(int(v)) {
			return fmt.Sprintf("%dK", int(v))
		}
		return fmt.Sprintf("%.1fK", v)
	default:
		return fmt.Sprintf("%d", n)
	}
}

// GroupedInt renders thousands with comma separators (e.g. 12,345).
func GroupedInt(n int64) string {
	s := strconv.FormatInt(n, 10)
	prefix := ""
	if n < 0 {
		prefix, s = "-", s[1:]
	}
	out := make([]byte, 0, len(s)+len(s)/3)
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, byte(c))
	}
	return prefix + string(out)
}

// DurationShort renders a duration as "3d 4h", "2h", "45m", or "<1m".
func DurationShort(d time.Duration) string {
	if d <= 0 {
		return "<1m"
	}
	if d < time.Minute {
		return "<1m"
	}
	days := int(d / (24 * time.Hour))
	d -= time.Duration(days) * 24 * time.Hour
	hours := int(d / time.Hour)
	d -= time.Duration(hours) * time.Hour
	mins := int(d / time.Minute)

	switch {
	case days > 0 && hours > 0:
		return fmt.Sprintf("%dd %dh", days, hours)
	case days > 0:
		return fmt.Sprintf("%dd", days)
	case hours > 0 && mins > 0:
		return fmt.Sprintf("%dh %dm", hours, mins)
	case hours > 0:
		return fmt.Sprintf("%dh", hours)
	default:
		return fmt.Sprintf("%dm", mins)
	}
}
