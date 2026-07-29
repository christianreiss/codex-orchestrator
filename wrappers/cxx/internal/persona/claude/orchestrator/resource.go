package orchestrator

import (
	"encoding/json"
	"strings"
)

func resourceContent(data json.RawMessage) (json.RawMessage, error) {
	if len(data) == 0 || strings.TrimSpace(string(data)) == "null" {
		return nil, nil
	}

	var rawString string
	if err := json.Unmarshal(data, &rawString); err == nil {
		if rawString == "" {
			return nil, nil
		}
		return json.RawMessage(rawString), nil
	}

	var payload struct {
		Content string `json:"content"`
		Body    string `json:"body"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	content := payload.Content
	if content == "" {
		content = payload.Body
	}
	if content == "" {
		return nil, nil
	}
	return json.RawMessage(content), nil
}
