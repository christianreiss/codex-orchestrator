package ui

import (
	"fmt"
	"time"
)

// CompactNumber renders large integers as "12K", "1.5M", "10M".
func CompactNumber(n int64) string {
	abs := n
	if abs < 0 {
		abs = -abs
	}
	switch {
	case abs >= 10_000_000:
		return fmt.Sprintf("%dM", n/1_000_000)
	case abs >= 1_000_000:
		v := float64(n) / 1_000_000
		if v == float64(int(v)) {
			return fmt.Sprintf("%dM", int(v))
		}
		return fmt.Sprintf("%.1fM", v)
	case abs >= 10_000:
		return fmt.Sprintf("%dK", n/1_000)
	case abs >= 1_000:
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
	s := fmt.Sprintf("%d", n)
	if n < 0 {
		return "-" + GroupedInt(-n)
	}
	out := []byte{}
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, byte(c))
	}
	return string(out)
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
