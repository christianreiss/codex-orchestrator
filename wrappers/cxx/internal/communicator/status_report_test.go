package communicator

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func statusLineFor(t *testing.T, out, base string) map[string]any {
	t.Helper()
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		var line map[string]any
		if json.Unmarshal([]byte(l), &line) == nil && line["server"] == base {
			return line
		}
	}
	t.Fatalf("no status line for %s in %q", base, out)
	return nil
}

// `sudo cxx communicator status` without XDG_RUNTIME_DIR must never print
// nothing: every unreachable or unreadable owner yields a line with an error
// and the runtime directory that was searched (feedback b03e3dbb).
func TestStatusNeverSilentForUnreadableOwner(t *testing.T) {
	dir, err := os.MkdirTemp("", "cxs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	t.Setenv("XDG_RUNTIME_DIR", "")
	restore := sessionRuntimeRoot
	sessionRuntimeRoot = func() string { return filepath.Join(dir, "no-logind") }
	t.Cleanup(func() { sessionRuntimeRoot = restore })

	serve := func(name string, handler http.HandlerFunc) string {
		socket := filepath.Join(dir, name)
		ln, err := net.Listen("unix", socket)
		if err != nil {
			t.Fatal(err)
		}
		srv := &http.Server{Handler: handler}
		go srv.Serve(ln)
		t.Cleanup(func() { srv.Close() })
		return socket
	}
	cases := []struct{ base, socket, want string }{
		{"https://status-text.example", serve("text.sock", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("not json")) }), "invalid JSON"},
		{"https://status-404.example", serve("404.sock", func(w http.ResponseWriter, _ *http.Request) { http.NotFound(w, nil) }), "HTTP 404"},
		{"https://status-missing.example", filepath.Join(dir, "missing.sock"), "missing.sock"},
	}
	for _, c := range cases {
		registry.Store(c.base, &endpoint{base: c.base, socket: c.socket})
		base := c.base
		t.Cleanup(func() { registry.Delete(base) })
	}
	for _, arg := range []string{"status", "doctor"} {
		var out, errOut bytes.Buffer
		code := Command([]string{arg}, strings.NewReader(""), &out, &errOut, "test")
		for _, c := range cases {
			line := statusLineFor(t, out.String(), c.base)
			msg, _ := line["error"].(string)
			if line["running"] != false || !strings.Contains(msg, c.want) {
				t.Fatalf("%s %s: line %v, want error containing %q", arg, c.base, line, c.want)
			}
			if line["runtime_dir_source"] != "tmp" || line["runtime_dir"] == "" || !strings.Contains(line["hint"].(string), "XDG_RUNTIME_DIR=/run/user/") {
				t.Fatalf("%s %s: runtime diagnostics missing: %v", arg, c.base, line)
			}
		}
		if arg == "doctor" && code != 1 {
			t.Fatalf("doctor must fail, exit %d", code)
		}
		if arg == "status" && code != 0 {
			t.Fatalf("status reports, it does not fail: exit %d", code)
		}
	}
}
