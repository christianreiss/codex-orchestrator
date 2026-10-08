package agentbus

import (
	"encoding/json"
	"strings"
	"time"
)

// Provider-native structured hints only. Do not guess reset times from prose.
func scheduleRetryAt(raw string, now time.Time) string {
	var latest time.Time
	var visit func(any)
	visit = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			for key, value := range v {
				if key == "retry_after_seconds" {
					if seconds, ok := value.(float64); ok && seconds > 0 && seconds <= 31536000 {
						at := now.Add(time.Duration(seconds * float64(time.Second)))
						if at.After(latest) {
							latest = at
						}
					}
				}
				if key == "retry_at" || key == "reset_at" {
					if text, ok := value.(string); ok {
						if at, err := time.Parse(time.RFC3339, text); err == nil && at.After(latest) {
							latest = at
						}
					}
				}
				visit(value)
			}
		case []any:
			for _, value := range v {
				visit(value)
			}
		}
	}
	for _, line := range strings.Split(raw, "\n") {
		var value any
		if json.Unmarshal([]byte(line), &value) == nil {
			visit(value)
		}
	}
	if latest.IsZero() {
		return ""
	}
	return latest.UTC().Format(time.RFC3339)
}
