package agentbus

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

type taskEvidence struct {
	Description string `json:"description"`
	Reference   string `json:"reference"`
}
type taskResult struct {
	Status   string         `json:"status"`
	Summary  string         `json:"summary"`
	Evidence []taskEvidence `json:"evidence,omitempty"`
}

func unknownResult() *taskResult {
	return &taskResult{Status: "unknown", Summary: "Transport completed without an explicit task result."}
}
func validateTaskResult(r *taskResult) error {
	if r == nil {
		return errors.New("task_result is required")
	}
	switch r.Status {
	case "succeeded", "failed", "blocked", "unknown":
	default:
		return errors.New("invalid task result status")
	}
	if strings.TrimSpace(r.Summary) == "" || len(r.Summary) > 4096 || len(r.Evidence) > 20 {
		return errors.New("invalid task result summary or evidence")
	}
	for _, e := range r.Evidence {
		if strings.TrimSpace(e.Description) == "" || len(e.Description) > 500 || strings.TrimSpace(e.Reference) == "" || len(e.Reference) > 2048 {
			return errors.New("invalid task evidence")
		}
	}
	return nil
}

// Parse only the complete final response, never infer success from exit codes or prose.
func parseTaskOutput(raw string) (string, *taskResult) {
	var body struct {
		Content    string      `json:"content"`
		TaskResult *taskResult `json:"task_result"`
	}
	dec := json.NewDecoder(bytes.NewBufferString(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		return raw, unknownResult()
	}
	var extra any
	if dec.Decode(&extra) != io.EOF || validateTaskResult(body.TaskResult) != nil || strings.TrimSpace(body.Content) == "" {
		return raw, unknownResult()
	}
	return body.Content, body.TaskResult
}

const taskOutputInstruction = "Report the actual task outcome, never equate delivery with success. Your entire final response must be JSON: {\"content\":\"human response\",\"task_result\":{\"status\":\"succeeded|failed|blocked|unknown\",\"summary\":\"plain result (maximum 4096 UTF-8 bytes)\",\"evidence\":[{\"description\":\"what was checked\",\"reference\":\"path, URL or command\"}]}}. Evidence is optional; do not invent it. Do not call agent_reply or agent_task_result for this background delivery; the worker stores the result and reply atomically.\n"
