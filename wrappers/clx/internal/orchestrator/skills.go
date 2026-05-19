package orchestrator

import (
	"context"
	"encoding/json"
	"net/http"
)

type Skill struct {
	Slug    string          `json:"slug"`
	Name    string          `json:"name,omitempty"`
	Version string          `json:"version,omitempty"`
	SHA256  string          `json:"sha256,omitempty"`
	Body    json.RawMessage `json:"body,omitempty"`
}

type SkillsList struct {
	Status string  `json:"status"`
	Data   []Skill `json:"data,omitempty"`
}

// ListSkills calls GET /skills?engine=claude so the response is filtered to
// skills marked for this engine (or unscoped/global ones). The server filter
// at api/src/services/host-skills.ts:60-65 keeps rows with engine=null/” too.
func (c *Client) ListSkills(ctx context.Context) ([]Skill, error) {
	out := &SkillsList{}
	if err := c.JSON(ctx, http.MethodGet, "/skills?engine=claude", nil, out, 1); err != nil {
		return nil, err
	}
	return out.Data, nil
}

type SkillRetrieved struct {
	Status string          `json:"status"`
	Data   json.RawMessage `json:"data,omitempty"`
}

func (c *Client) RetrieveSkill(ctx context.Context, slug string) (json.RawMessage, error) {
	out := &SkillRetrieved{}
	if err := c.JSON(ctx, http.MethodPost, "/skills/retrieve", map[string]string{"slug": slug}, out, 1); err != nil {
		return nil, err
	}
	return out.Data, nil
}
