package communicator

import (
	"context"
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

func TestNativeCachePreservesPairedIdentityAndSessionIsolation(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			f := frame{Method: "POST", Path: "/mcp", Headers: map[string]string{"x-engine": engine, "x-agent-session-id": "session-a", "x-agent-bridge-token": "bridge-a"}, Body: []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"skill_list"}}`)}
			var cache validatedRAM
			_, _, err := cache.read(context.Background(), f, func(_ context.Context, in frame) (frame, bool, error) {
				var proof cacheRead
				_ = json.Unmarshal(in.Body, &proof)
				if proof.Headers["x-agent-session-id"] != "session-a" || proof.Headers["x-agent-bridge-token"] != "bridge-a" || proof.Headers["x-engine"] != engine {
					t.Error("native identity pair lost before server authentication")
				}
				return cacheFixture(t, in, "confirmed", nil), false, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			for range 2 {
				_, _, err := cache.readMode(context.Background(), f, func(_ context.Context, in frame) (frame, bool, error) {
					calls++
					return localFixture(t, in, "fresh-native", nil), false, nil
				}, LocalContentCacheProtocol, func() bool { return true })
				if err != nil {
					t.Fatal(err)
				}
			}
			if calls != 2 || cache.localHits != 0 {
				t.Error("native scope reused a host-only content grant")
			}
			one := cacheKey(f, map[string]json.RawMessage{})
			f.Headers["x-agent-session-id"] = "session-b"
			if cacheKey(f, map[string]json.RawMessage{}) == one {
				t.Error("native sessions share a cache key")
			}
		})
	}
}

func TestExpandedAndNativeReadsBypassUncapableOwnerBeforeDispatch(t *testing.T) {
	for _, tc := range []struct {
		name          string
		localProtocol int
		native        bool
	}{
		{"shared_memory_search", 0, false}, {"project_file_read", 0, false}, {"memory_retrieve", 0, false}, {"shared_memory_read", 0, false},
		{"skill_list", 3, true}, {"skill_retrieve", 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var oldRequests, confirmations atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				confirmations.Add(1)
				if r.URL.Path != "/sync/cache" {
					t.Error("wrong direct proof route")
				}
				raw, _ := io.ReadAll(r.Body)
				var proof cacheRead
				_ = json.Unmarshal(raw, &proof)
				if tc.native && (proof.Headers["x-agent-session-id"] != "fixture-session" || proof.Headers["x-agent-bridge-token"] != "fixture-bridge") {
					t.Error("direct bridge lost paired identity")
				}
				f := cacheFixture(t, frame{Body: raw}, "fresh", nil)
				_, _ = w.Write(f.Body)
			}))
			defer remote.Close()
			dir, err := os.MkdirTemp("", "cxx-scope-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(dir)
			socket := ownerSocket(t, dir, "owner.sock", func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/_comm/status" {
					_ = json.NewEncoder(w).Encode(map[string]any{"version": "0.9.127", "cache": map[string]int{"protocol": 2, "local_content_protocol": tc.localProtocol}})
					return
				}
				oldRequests.Add(1)
				_, _ = io.WriteString(w, `{"stale":true}`)
			})
			ep := &endpoint{base: remote.URL, socket: socket, anchor: &config.Config{Engine: config.EngineCodex, Orchestrator: config.Orchestrator{BaseURL: remote.URL, APIKey: "host-key", CommunicatorProtocol: 1, CommunicatorCacheProtocol: 3}}}
			ep.once.Do(func() {})
			registry.Store(remote.URL, ep)
			defer registry.Delete(remote.URL)
			for i := 0; i < 2; i++ {
				req, _ := http.NewRequest("POST", remote.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"`+tc.name+`","arguments":{}}}`))
				if tc.native {
					req.Header.Set("X-Agent-Session-Id", "fixture-session")
					req.Header.Set("X-Agent-Bridge-Token", "fixture-bridge")
				}
				res, err := (&Transport{Direct: http.DefaultTransport}).RoundTrip(req)
				if err != nil {
					t.Fatal(err)
				}
				_, _ = io.Copy(io.Discard, res.Body)
				_ = res.Body.Close()
				if res.StatusCode != 200 {
					t.Errorf("fresh selected read returned %d", res.StatusCode)
				}
			}
			if oldRequests.Load() != 0 || confirmations.Load() != 2 {
				t.Fatalf("legacy application requests=%d confirmations=%d", oldRequests.Load(), confirmations.Load())
			}
		})
	}
}
