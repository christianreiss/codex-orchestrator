package orchestrator

import (
	"context"
	"encoding/json"
	"net/http"
)

// Skill is the minimal shape needed to know which skills exist and to detect
// changes. The server's `decorate()` emits {slug, sha256, display_name,
// description, …}; we only need slug + sha256 for the change fingerprint and
// keep display_name for future surfacing. The server side is authoritative; we
// tolerate extra fields.
type Skill struct {
	Slug        string `json:"slug"`
	SHA256      string `json:"sha256,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
}

// SkillsList decodes GET /skills?engine=<engine>. The handler returns
// {engine, skills:[…]}, which the standard envelope exposes both at the root
// and under `data` — so the skill array lives at `skills`/`data.skills`, NOT at
// `data` itself (decoding the object into a []Skill was the bug that kept the
// boot-screen "skills" dot from ever flipping to updated).
type SkillsList struct {
	Status string  `json:"status"`
	Skills []Skill `json:"skills"`
	Data   struct {
		Skills []Skill `json:"skills"`
	} `json:"data"`
}

func (c *Client) ListSkills(ctx context.Context) ([]Skill, error) {
	out := &SkillsList{}
	// This binary is the Codex wrapper, so the skills list is always scoped to
	// engine=codex (matches GET /skills?engine=codex in docs/interface-cdx.md);
	// without the scope a dual-engine host would also fingerprint Claude skills.
	if err := c.JSON(ctx, http.MethodGet, "/skills?engine=codex", nil, out, 1); err != nil {
		return nil, err
	}
	if len(out.Skills) > 0 {
		return out.Skills, nil
	}
	return out.Data.Skills, nil
}

// SkillRetrieved is the body returned by /skills/retrieve. The orchestrator
// returns the manifest contents which we persist on disk.
type SkillRetrieved struct {
	Status string          `json:"status"`
	Data   json.RawMessage `json:"data,omitempty"`
}

func (c *Client) RetrieveSkill(ctx context.Context, slug string) (json.RawMessage, error) {
	out := &SkillRetrieved{}
	if err := c.JSON(ctx, http.MethodPost, "/skills/retrieve", map[string]string{"slug": slug, "engine": "codex"}, out, 1); err != nil {
		return nil, err
	}
	return out.Data, nil
}
