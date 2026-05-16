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
