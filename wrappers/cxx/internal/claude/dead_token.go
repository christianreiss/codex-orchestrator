package claude

import (
	"encoding/json"
	"strings"
	"time"
)

// DeadTokenAdoptMargin is how long a canonical access token must still be
// valid before it may replace a dead-token clear. Claude Code refreshes inside
// the last five minutes of an access token, so a canonical inside that window
// would be refreshed again at once; when it is the very pair whose refresh
// just failed, that is a replay of a spent refresh token.
const DeadTokenAdoptMargin = 10 * time.Minute

// IsDeadTokenClear reports Claude Code's own dead-token record: after the
// OAuth endpoint answers invalid_grant (typically because another host
// refreshed the same grant first and the rotated refresh token was already
// spent), Claude Code keeps the claudeAiOauth block but blanks both tokens and
// zeroes expiresAt. It is not a logout: `/logout` removes the block or the
// file. The account identity fields stay in place, which lets a verified
// canonical of the same login be adopted over it.
func IsDeadTokenClear(raw []byte) bool {
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return false
	}
	oauth, ok := doc["claudeAiOauth"].(map[string]any)
	if !ok {
		return false
	}
	access, accessOK := oauth["accessToken"].(string)
	refresh, refreshOK := oauth["refreshToken"].(string)
	return accessOK && refreshOK && strings.TrimSpace(access) == "" && strings.TrimSpace(refresh) == ""
}

// DeadTokenHealCandidate decides whether a verified canonical payload may
// replace a dead-token clear. The canonical must be a runnable OAuth login
// whose access token outlives DeadTokenAdoptMargin, and, when both sides name
// their Claude account, it must be the same account: a different account is
// a live switch, which belongs to the turn gate.
func DeadTokenHealCandidate(local, canonical []byte, now time.Time) bool {
	native, err := extractClaudeFormat(json.RawMessage(canonical))
	if err != nil || !isUsableAuth(native) {
		return false
	}
	var incoming, current map[string]any
	if json.Unmarshal(native, &incoming) != nil || json.Unmarshal(local, &current) != nil {
		return false
	}
	in, _ := incoming["claudeAiOauth"].(map[string]any)
	if in == nil {
		return false
	}
	expires, known := epochMillis(in["expiresAt"])
	if !known || !expires.After(now.Add(DeadTokenAdoptMargin)) {
		return false
	}
	have, _ := current["claudeAiOauth"].(map[string]any)
	localAccount, _ := have["accountUuid"].(string)
	canonicalAccount, _ := in["accountUuid"].(string)
	if strings.TrimSpace(localAccount) != "" && strings.TrimSpace(canonicalAccount) != "" && localAccount != canonicalAccount {
		return false
	}
	return true
}
