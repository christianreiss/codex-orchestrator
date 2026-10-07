package agentportal

import "strings"

// CompactSummary keeps Unicode intact and agrees with the companion's preview limit.
// Empty summaries remain valid for older callers; they never fall back to the full response.
func CompactSummary(value string) string {
	text := strings.Join(strings.Fields(value), " ")
	chars := []rune(text)
	if len(chars) > 160 {
		return strings.TrimSpace(string(chars[:159])) + "…"
	}
	return text
}
