package codex

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestBackfillLastRefreshMissingField(t *testing.T) {
	in := []byte(`{"tokens":{"access_token":"abc"}}`)
	out, modified, err := BackfillLastRefresh(in)
	if err != nil {
		t.Fatalf("BackfillLastRefresh: %v", err)
	}
	if !modified {
		t.Fatalf("expected modified=true for missing last_refresh")
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("output not valid JSON: %v", err)
	}
	stamp, ok := got["last_refresh"].(string)
	if !ok || strings.TrimSpace(stamp) == "" {
		t.Fatalf("last_refresh missing/empty after backfill: %v", got["last_refresh"])
	}
	if _, err := time.Parse(time.RFC3339, stamp); err != nil {
		t.Fatalf("last_refresh %q not RFC3339: %v", stamp, err)
	}
	if got["tokens"] == nil {
		t.Fatalf("tokens lost during backfill: %v", got)
	}
}

func TestBackfillLastRefreshEmptyField(t *testing.T) {
	in := []byte(`{"last_refresh":"   ","tokens":{}}`)
	out, modified, err := BackfillLastRefresh(in)
	if err != nil {
		t.Fatalf("BackfillLastRefresh: %v", err)
	}
	if !modified {
		t.Fatalf("expected modified=true for whitespace-only last_refresh")
	}
	var got map[string]any
	_ = json.Unmarshal(out, &got)
	if s, _ := got["last_refresh"].(string); strings.TrimSpace(s) == "" {
		t.Fatalf("last_refresh still empty after backfill: %q", s)
	}
}

func TestBackfillLastRefreshAlreadyPresentNoOp(t *testing.T) {
	in := []byte(`{"last_refresh":"2026-01-02T03:04:05Z","tokens":{}}`)
	out, modified, err := BackfillLastRefresh(in)
	if err != nil {
		t.Fatalf("BackfillLastRefresh: %v", err)
	}
	if modified {
		t.Fatalf("expected modified=false when last_refresh already set")
	}
	if string(out) != string(in) {
		t.Fatalf("payload mutated on no-op path: %s", string(out))
	}
}

func TestBackfillLastRefreshInvalidJSONPassthrough(t *testing.T) {
	in := []byte(`not json at all`)
	out, modified, err := BackfillLastRefresh(in)
	if err != nil {
		t.Fatalf("BackfillLastRefresh on invalid JSON should not error: %v", err)
	}
	if modified {
		t.Fatalf("invalid JSON must not be reported as modified")
	}
	if string(out) != string(in) {
		t.Fatalf("invalid JSON should pass through unchanged: %s", string(out))
	}
}

func TestBackfillLastRefreshEmptyInput(t *testing.T) {
	out, modified, err := BackfillLastRefresh(nil)
	if err != nil || modified || len(out) != 0 {
		t.Fatalf("nil input should produce no-op: out=%q modified=%v err=%v", out, modified, err)
	}
}
