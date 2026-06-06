package orchestrator

import (
	"context"
	"encoding/json"
	"net/http"
)

// Skill is the minimal shape needed to know which skills exist and to write
// each one to disk. The server side is authoritative; we tolerate extra fields.
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

func (c *Client) ListSkills(ctx context.Context) ([]Skill, error) {
	out := &SkillsList{}
	if err := c.JSON(ctx, http.MethodGet, "/skills", nil, out, 1); err != nil {
		return nil, err
	}
	return out.Data, nil
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
