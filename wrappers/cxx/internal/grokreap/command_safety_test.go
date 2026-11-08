package grokreap

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestSuspendedJSONDoesNotInspectProcesses(t *testing.T) {
	var out, errout bytes.Buffer
	if code := Command(false, true, true, &out, &errout); code != 0 {
		t.Fatalf("code=%d %s", code, &errout)
	}
	var result map[string]any
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result["outcome"] != "suspended" || result["engine"] != "grok" || errout.Len() != 0 {
		t.Fatalf("result=%v stderr=%s", result, &errout)
	}
}
