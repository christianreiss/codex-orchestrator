package claude

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

const loginWarningWindow = 3 * 24 * time.Hour

// LoginExpiryWarning is advisory and reads the selected local credential after
// sync. It never spends refresh material or changes launch eligibility.
func LoginExpiryWarning(path string, now time.Time) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return loginExpiryWarning(raw, now)
}

func loginExpiryWarning(raw []byte, now time.Time) string {
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return ""
	}
	kind, _, usable := runnableCredentialIdentity(doc)
	if !usable || kind != "oauth" {
		return ""
	}
	oauth, _ := doc["claudeAiOauth"].(map[string]any)
	expiry, known := epochMillis(oauth["refreshTokenExpiresAt"])
	if !known || expiry.Year() < 2000 || expiry.Year() >= 2200 {
		return ""
	}
	if access, ok := epochMillis(oauth["expiresAt"]); ok && access.After(expiry.Add(loginWarningWindow)) {
		return ""
	}
	remaining := expiry.Sub(now)
	if remaining > loginWarningWindow {
		return ""
	}
	message := "Claude login expired"
	if remaining > 0 {
		days := int((remaining + 24*time.Hour - 1) / (24 * time.Hour))
		unit := "days"
		if days == 1 {
			unit = "day"
		}
		message = fmt.Sprintf("Claude login expires in %d %s", days, unit)
	}
	return fmt.Sprintf("%s (expiry %s). Run /login in Claude launched through clx.", message, expiry.UTC().Format(time.RFC3339))
}
