package housekeeping

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPinDryRunCannotChangeProtectionAndJSONStaysMachineReadable(t *testing.T) {
	root := t.TempDir()
	t.Setenv("CODEX_HOME", root)
	const id = "11111111-1111-4111-8111-111111111111"
	for _, action := range []string{"pin", "unpin"} {
		var out, errout bytes.Buffer
		if code := Command([]string{action, id, "--engine", "codex", "--dry-run"}, "", &out, &errout); code != 2 {
			t.Fatalf("%s dry run=%d %s", action, code, &errout)
		}
		entries, err := os.ReadDir(root)
		if err != nil || len(entries) != 0 {
			t.Fatalf("dry-run wrote protection state: %v %v", entries, err)
		}
	}
	for _, action := range []string{"pin", "unpin"} {
		var out, errout bytes.Buffer
		if code := Command([]string{action, id, "--engine", "codex", "--json"}, "", &out, &errout); code != 0 {
			t.Fatalf("%s=%d %s", action, code, &errout)
		}
		var got struct {
			Engine string `json:"engine"`
			ID     string `json:"session_id"`
			Pinned bool   `json:"pinned"`
		}
		if err := json.Unmarshal(out.Bytes(), &got); err != nil {
			t.Fatalf("stdout not JSON: %q: %v", &out, err)
		}
		if got.Engine != "codex" || got.ID != id || got.Pinned != (action == "pin") {
			t.Fatalf("receipt=%+v", got)
		}
		pins, err := loadPins(root)
		if err != nil || pins[id] != (action == "pin") {
			t.Fatalf("protection not updated: %v %v", pins, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, ".cxx-housekeeping", "pins.json")); err != nil {
		t.Fatal(err)
	}
}
