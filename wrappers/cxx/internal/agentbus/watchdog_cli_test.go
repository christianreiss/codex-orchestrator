package agentbus

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestWatchdogCLIUsesCurrentBridgeAndExplicitVersions(t *testing.T) {
	var bodies []map[string]any
	var paths []string
	commandBroker(t, func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		json.NewDecoder(r.Body).Decode(&b)
		bodies = append(bodies, b)
		paths = append(paths, r.URL.Path)
		io.WriteString(w, `{"id":"watchdog","version":1}`)
	})
	var out bytes.Buffer
	if code := RunWatchdogCommand([]string{"on", "--task-key", "task", "--stdin"}, strings.NewReader("Continue the current task"), &out, io.Discard); code != 0 {
		t.Fatal(code)
	}
	if bodies[0]["duration_seconds"] != float64(7200) || bodies[0]["progress_timeout_seconds"] != float64(600) || bodies[0]["target"] != nil {
		t.Fatal(bodies)
	}
	if err := runWatchdog([]string{"status"}, nil, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if err := runWatchdog([]string{"off", "--id", "watchdog", "--version", "1"}, nil, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(paths[0], "watchdog/enable") || !strings.HasSuffix(paths[2], "watchdog/disable") || bodies[2]["version"] != float64(1) {
		t.Fatal(paths, bodies)
	}
	count := len(paths)
	for _, args := range [][]string{{"on", "--task-key", "task"}, {"off", "--id", "watchdog"}, {"on", "--task-key", "task", "--stdin", "--duration", "0s"}} {
		if err := runWatchdog(args, strings.NewReader("task"), io.Discard, io.Discard); err == nil {
			t.Fatal("invalid input accepted", args)
		}
	}
	if len(paths) != count {
		t.Fatal("invalid input mutated server")
	}
}
