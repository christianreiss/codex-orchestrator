package orchestrator

import "encoding/json"

// ConfigProfile is one Codex profile the fleet ships as `<name>.config.toml`,
// carried in the `profiles` list of the `/sync/bootstrap` config block.
type ConfigProfile struct {
	Name    string `json:"name"`
	SHA256  string `json:"sha256"`
	Content string `json:"content"`
}

// profilesFromRaw reads the `profiles` list out of a config reply object. It is
// nil when the key is absent or null and non-nil (possibly empty) when present,
// which is what lets the caller tell "no profiles" from "server sent none".
func profilesFromRaw(raw json.RawMessage) []ConfigProfile {
	if len(raw) == 0 {
		return nil
	}
	var doc struct {
		Profiles *[]ConfigProfile `json:"profiles"`
	}
	if json.Unmarshal(raw, &doc) != nil || doc.Profiles == nil {
		return nil
	}
	if *doc.Profiles == nil {
		return []ConfigProfile{}
	}
	return *doc.Profiles
}
