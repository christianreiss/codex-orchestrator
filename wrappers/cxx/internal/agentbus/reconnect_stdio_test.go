package agentbus

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/testhome"
)

// Keep both native pipes and the same launch identity across local broker
// replacement. A failed tool reports an error; it must not close MCP stdin.
func TestMCPStdioSurvivesSameBindingBrokerReplacement(t *testing.T) {
	testhome.Isolate(t)
	for _, engine := range []string{"codex", "claude", "grok", "kimi"} {
		t.Run(engine, func(t *testing.T) {
			t.Setenv("CXX_AGENT_PORTAL_ENGINE", engine)
			socket := filepath.Join(t.TempDir(), "broker.sock")
			start := func() *http.Server {
				ln, err := net.Listen("unix", socket)
				if err != nil {
					t.Fatal(err)
				}
				srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if !strings.HasPrefix(r.URL.Path, "/host/agent-sessions/original/") {
						t.Errorf("binding changed: %s", r.URL.Path)
					}
					fmt.Fprint(w, `{"session_id":"original","binding_generation":1}`)
				})}
				go srv.Serve(ln)
				return srv
			}
			srv := start()
			defer func() { srv.Close() }()
			input, write := io.Pipe()
			output, read := io.Pipe()
			done := make(chan error, 1)
			go func() {
				done <- runMCPProtocol(sessionClientAt(socket, "original", time.Second), false, input, read, io.Discard)
			}()
			defer func() {
				write.Close()
				select {
				case err := <-done:
					if err != nil {
						t.Error(err)
					}
				case <-time.After(3 * time.Second):
					t.Error("MCP did not finish")
				}
				output.Close()
			}()
			lines := make(chan string, 1)
			go func() {
				s := bufio.NewScanner(output)
				for s.Scan() {
					lines <- s.Text()
				}
			}()
			call := func(id int, wantError bool) {
				fmt.Fprintf(write, "{\"jsonrpc\":\"2.0\",\"id\":%d,\"method\":\"tools/call\",\"params\":{\"name\":\"agent_self\",\"arguments\":{}}}\n", id)
				select {
				case line := <-lines:
					var msg struct {
						ID     int
						Result struct {
							IsError    bool           `json:"isError"`
							Structured map[string]any `json:"structuredContent"`
						}
					}
					if json.Unmarshal([]byte(line), &msg) != nil || msg.ID != id || msg.Result.IsError != wantError {
						t.Fatalf("reply=%s", line)
					}
					if !wantError && msg.Result.Structured["session_id"] != "original" {
						t.Fatalf("lost original binding: %s", line)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("native pipe closed or stuck")
				}
			}
			call(1, false)
			srv.Close()
			call(2, true)
			srv = start()
			call(3, false)
		})
	}
}
