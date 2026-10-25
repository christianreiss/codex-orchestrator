package communicator

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestNativeScopeCapableOwnerKeepsProtocol3ReceiptWithoutDirectReplay(t *testing.T) {
	for _, receipt := range []bool{true, false} {
		t.Run(map[bool]string{true: "confirmed", false: "lost-receipt"}[receipt], func(t *testing.T) {
			var direct, dispatched atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { direct.Add(1) }))
			defer remote.Close()
			dir, err := os.MkdirTemp("", "cxx-native-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(dir)
			socket := ownerSocket(t, dir, "owner.sock", func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/_comm/status" {
					_ = json.NewEncoder(w).Encode(map[string]any{"version": "0.9.130", "cache": map[string]int{"protocol": 2, "local_content_protocol": 3, "native_scope_protocol": 1}})
					return
				}
				dispatched.Add(1)
				if r.Header.Get("X-Agent-Session-Id") != "session" || r.Header.Get("X-Agent-Bridge-Token") != "bridge" || r.Header.Get("X-Cxx-Cache-Protocol") != "3" {
					t.Error("native scope or compatible protocol lost")
				}
				if receipt {
					w.Header().Set("X-Cxx-Cache-Protocol", "3")
				}
				_, _ = io.WriteString(w, `{"fresh":true}`)
			})
			ep := &endpoint{base: remote.URL, socket: socket, anchor: &config.Config{Orchestrator: config.Orchestrator{BaseURL: remote.URL, CommunicatorProtocol: 1, CommunicatorCacheProtocol: 3}}}
			ep.once.Do(func() {})
			registry.Store(remote.URL, ep)
			defer registry.Delete(remote.URL)
			req, _ := http.NewRequest("POST", remote.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"skill_list"}}`))
			req.Header.Set("X-Agent-Session-Id", "session")
			req.Header.Set("X-Agent-Bridge-Token", "bridge")
			res, err := (&Transport{Direct: http.DefaultTransport}).RoundTrip(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			want := 200
			if !receipt {
				want = 409
			}
			if res.StatusCode != want || direct.Load() != 0 || dispatched.Load() != 1 {
				t.Fatalf("status=%d direct=%d dispatched=%d", res.StatusCode, direct.Load(), dispatched.Load())
			}
		})
	}
}
