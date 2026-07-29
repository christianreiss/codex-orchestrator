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

// SkillsList decodes GET /skills?engine=claude. The handler returns
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

// ListSkills calls GET /skills?engine=claude so the response is filtered to
// skills marked for this engine (or unscoped/global ones). The server filter
// at api/src/services/host-skills.ts:60-65 keeps rows with engine=null/” too.
func (c *Client) ListSkills(ctx context.Context) ([]Skill, error) {
	out := &SkillsList{}
	if err := c.JSON(ctx, http.MethodGet, "/skills?engine=claude", nil, out, 1); err != nil {
		return nil, err
	}
	if len(out.Skills) > 0 {
		return out.Skills, nil
	}
	return out.Data.Skills, nil
}

type SkillRetrieved struct {
	Status string          `json:"status"`
	Data   json.RawMessage `json:"data,omitempty"`
}

func (c *Client) RetrieveSkill(ctx context.Context, slug string) (json.RawMessage, error) {
	out := &SkillRetrieved{}
	if err := c.JSON(ctx, http.MethodPost, "/skills/retrieve", map[string]string{"slug": slug, "engine": "claude"}, out, 1); err != nil {
		return nil, err
	}
	return out.Data, nil
}
