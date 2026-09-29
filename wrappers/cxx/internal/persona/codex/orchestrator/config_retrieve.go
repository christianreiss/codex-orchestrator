package orchestrator

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/user"
)

type ConfigRetrieveResponse struct {
	Status string          `json:"status"`
	Data   json.RawMessage `json:"data,omitempty"`
	// Profiles is read from the root too: the standard envelope repeats a
	// reply's fields both at the root and under `data`.
	Profiles *[]ConfigProfile `json:"profiles,omitempty"`
}

// ConfigProfile is one Codex profile the fleet ships as `<name>.config.toml`.
type ConfigProfile struct {
	Name    string `json:"name"`
	SHA256  string `json:"sha256"`
	Content string `json:"content"`
}

// ConfigBundle is a /config/retrieve reply: the config.toml body (empty when the
// server reported `unchanged`) and the profile sidecars. Profiles is nil when the
// server sent no `profiles` key at all (a Codex that still reads [profiles.*]
// from config.toml, or an older server) and non-nil, possibly empty, when it did:
// only a present list may prune.
type ConfigBundle struct {
	Content  json.RawMessage
	Profiles []ConfigProfile
}

// RetrieveConfig fetches the rendered config.toml body for this host.
//
// The POST body includes `home` and `username` hints so the server can bake
// the per-user `[projects."<home>"] trust_level=trusted` stanza (see
// fe70ac3:docs/interface-cdx.md "Config Bake Rules").
func (c *Client) RetrieveConfig(ctx context.Context, digest string) (json.RawMessage, error) {
	bundle, err := c.RetrieveConfigBundle(ctx, digest)
	if err != nil {
		return nil, err
	}
	return bundle.Content, nil
}

// RetrieveConfigBundle is RetrieveConfig plus the profile sidecars.
func (c *Client) RetrieveConfigBundle(ctx context.Context, digest string) (ConfigBundle, error) {
	body := map[string]any{"engine": "codex"}
	if digest != "" {
		body["sha256"] = digest
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		body["home"] = home
	}
	if u, err := user.Current(); err == nil && u != nil && u.Username != "" {
		body["username"] = u.Username
	}
	out := &ConfigRetrieveResponse{}
	if err := c.JSON(ctx, http.MethodPost, "/config/retrieve", body, out, 1); err != nil {
		return ConfigBundle{}, err
	}
	content, err := resourceContent(out.Data)
	if err != nil {
		return ConfigBundle{}, err
	}
	bundle := ConfigBundle{Content: content}
	profiles := out.Profiles
	if nested := profilesFromRaw(out.Data); nested != nil {
		bundle.Profiles = nested
	} else if profiles != nil {
		bundle.Profiles = *profiles
		if bundle.Profiles == nil {
			bundle.Profiles = []ConfigProfile{}
		}
	}
	return bundle, nil
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
