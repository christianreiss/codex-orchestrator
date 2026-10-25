package communicator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func localFixture(t *testing.T, in frame, content string, until *string) frame {
	return cacheFixture(t, in, content, func(r *cacheReply) { r.Protocol = 3; r.LocalContent = true; r.GrantUntil = until })
}
func TestLocalContentTenThousandHitsDoNotContactServer(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			var cache validatedRAM
			calls := 0
			f := frame{Method: "POST", Path: "/config/retrieve", Headers: map[string]string{"x-engine": engine}, Body: []byte(`{"home":"/native"}`)}
			exchange := func(_ context.Context, in frame) (frame, bool, error) {
				calls++
				return localFixture(t, in, "current", nil), false, nil
			}
			for i := 0; i < 10001; i++ {
				out, _, err := cache.readMode(context.Background(), f, exchange, 3, func() bool { return true })
				if err != nil || !strings.Contains(string(out.Body), `"content":"current"`) {
					t.Fatalf("hit %d: %s %v", i, out.Body, err)
				}
			}
			if calls != 1 || cache.localHits != 10000 {
				t.Fatalf("server calls=%d; local hits=%d", calls, cache.localHits)
			}
			offline := func(context.Context, frame) (frame, bool, error) {
				t.Fatal("loaded content contacted offline server")
				return frame{}, false, errors.New("offline")
			}
			if _, _, err := cache.readMode(context.Background(), f, offline, 3, func() bool { return false }); err != nil {
				t.Fatal(err)
			}
			cache.invalidateLocal()
			if _, _, err := cache.readMode(context.Background(), f, exchange, 3, func() bool { return true }); err != nil {
				t.Fatal(err)
			}
			if calls != 2 {
				t.Fatalf("invalidation did not fetch current content: %d", calls)
			}
		})
	}
}
func TestLocalContentConcurrentMissAndScopeIsolation(t *testing.T) {
	var cache validatedRAM
	var calls atomic.Int32
	exchange := func(_ context.Context, in frame) (frame, bool, error) {
		calls.Add(1)
		return localFixture(t, in, "one", nil), false, nil
	}
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := cache.readMode(context.Background(), frame{Method: "GET", Path: "/skills", Headers: map[string]string{"authorization": "host-a"}}, exchange, 3, func() bool { return true })
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("concurrent server calls=%d", calls.Load())
	}
	for _, identity := range []string{"host-b", "engine-b", "user-b"} {
		f := frame{Method: "GET", Path: "/skills", Headers: map[string]string{"authorization": identity}}
		if _, _, err := cache.readMode(context.Background(), f, exchange, 3, func() bool { return true }); err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 4 {
		t.Fatalf("identity scopes were shared: %d", calls.Load())
	}
}
func TestLocalContentRevocationDuringFillAndAbsoluteExpiry(t *testing.T) {
	var cache validatedRAM
	f := frame{Method: "GET", Path: "/skills"}
	_, _, err := cache.readMode(context.Background(), f, func(_ context.Context, in frame) (frame, bool, error) {
		cache.invalidateLocal()
		return localFixture(t, in, "obsolete", nil), false, nil
	}, 3, func() bool { return true })
	if err == nil {
		t.Fatal("in-flight invalidation retained a stale response")
	}
	until := time.Now().Add(20 * time.Millisecond).UTC().Format(time.RFC3339Nano)
	exchange := func(_ context.Context, in frame) (frame, bool, error) {
		return localFixture(t, in, "valid", &until), false, nil
	}
	if _, _, err = cache.readMode(context.Background(), f, exchange, 3, func() bool { return true }); err != nil {
		t.Fatal(err)
	}
	time.Sleep(25 * time.Millisecond)
	offline := func(context.Context, frame) (frame, bool, error) {
		return frame{}, false, errors.New("expired and offline")
	}
	if _, _, err = cache.readMode(context.Background(), f, offline, 3, func() bool { return false }); err == nil {
		t.Fatal("expired authority survived offline")
	}
}
func TestLocalContentRejectsAdmissionAndRebindsRPCIDs(t *testing.T) {
	for _, f := range []frame{{Method: "POST", Path: "/auth/sessions", Body: []byte(`{}`)}, {Method: "POST", Path: "/sync/bootstrap", Body: []byte(`{"include_auth":true}`)}, {Method: "POST", Path: "/sync/bootstrap", Body: []byte(`{"include_auth":false,"session_id":"x"}`)}} {
		if localContentCandidate(f) {
			t.Fatalf("local admission: %s", f.Path)
		}
	}
	var cache validatedRAM
	calls := 0
	exchange := func(_ context.Context, in frame) (frame, bool, error) {
		calls++
		var read cacheRead
		_ = json.Unmarshal(in.Body, &read)
		var id any
		_ = json.Unmarshal(read.Body["id"], &id)
		out := localFixture(t, in, "skill", nil)
		var envelope struct{ Data cacheReply }
		_ = json.Unmarshal(out.Body, &envelope)
		envelope.Data.Resources = nil
		envelope.Data.Body = json.RawMessage(fmt.Sprintf(`{"jsonrpc":"2.0","id":%v,"result":{"content":"skill"}}`, id))
		out.Body, _ = json.Marshal(envelope)
		return out, false, nil
	}
	for i := 1; i <= 2; i++ {
		f := frame{Method: "POST", Path: "/mcp", Body: []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"skill_list"}}`, i))}
		out, _, err := cache.readMode(context.Background(), f, exchange, 3, func() bool { return true })
		if err != nil || !strings.Contains(string(out.Body), fmt.Sprintf(`"id":%d`, i)) {
			t.Fatalf("RPC id: %s %v", out.Body, err)
		}
	}
	if calls != 1 {
		t.Fatalf("RPC hits=%d", calls)
	}
}

func TestLocalContentTargetedPushPreservesUnrelatedContentAndDeniesPrivateOfflineRead(t *testing.T) {
	var cache validatedRAM
	calls := 0
	online := true
	exchange := func(_ context.Context, in frame) (frame, bool, error) {
		calls++
		return localFixture(t, in, "current", nil), false, nil
	}
	config := frame{Method: "POST", Path: "/config/retrieve", Body: []byte(`{}`)}
	knowledge := frame{Method: "POST", Path: "/mcp", Body: []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"shared_memory_read","arguments":{"slug":"one"}}}`)}
	for _, f := range []frame{config, knowledge} {
		if _, _, err := cache.readMode(context.Background(), f, exchange, 3, func() bool { return online }); err != nil {
			t.Fatal(err)
		}
	}
	cache.invalidateLocal("skills")
	for _, f := range []frame{config, knowledge} {
		if _, _, err := cache.readMode(context.Background(), f, exchange, 3, func() bool { return online }); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 2 {
		t.Fatal("unrelated skill change discarded config/knowledge")
	}
	online = false
	_, _, err := cache.readMode(context.Background(), knowledge, func(context.Context, frame) (frame, bool, error) { return frame{}, false, errors.New("offline") }, 3, func() bool { return online })
	if err == nil {
		t.Fatal("private knowledge served after coherence connection ended")
	}
	online = true
	cache.invalidateLocal("knowledge")
	for _, f := range []frame{config, knowledge} {
		if _, _, err := cache.readMode(context.Background(), f, exchange, 3, func() bool { return online }); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 3 {
		t.Fatal("knowledge invalidation was not targeted")
	}
}

func TestLocalContentRealNativeWarmLaunchStillRequiresLiveAdmission(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a signed real binary")
	}
	rig := newProfRig(t, true, func(cfg *config.Config) { cfg.Orchestrator.CommunicatorCacheProtocol = LocalContentCacheProtocol })
	for _, label := range []string{"cold local-content launch", "warm local-content launch"} {
		out := rig.run(label, "claude", "run", "--minimal")
		if out.ExitCode != 0 || out.NativeAt <= 0 {
			t.Fatalf("%s: %d %s", label, out.ExitCode, out.Stdout)
		}
	}
	rig.api.configure(func(a *profAPI) { a.cacheFailure = true })
	refused := rig.run("offline admission", "claude", "run", "--minimal")
	if refused.ExitCode == 0 || refused.NativeAt != 0 {
		t.Fatalf("cached content bypassed offline admission: %d %s", refused.ExitCode, refused.Stdout)
	}
}
