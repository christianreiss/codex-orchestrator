package communicator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// Model the server's resource protocol around the existing native-start API.
func profCacheReply(api *profAPI, raw []byte) (int, []byte) {
	var in cacheRead
	if json.Unmarshal(raw, &in) != nil {
		return 400, nil
	}
	for _, key := range []string{"agents", "config", "skills", "artifacts", "sha256"} {
		delete(in.Body, key)
	}
	body, _ := json.Marshal(in.Body)
	status, payload := api.handle(in.Method, in.Path, body)
	if status >= 400 {
		return status, payload
	}
	var template any
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.UseNumber()
	if decoder.Decode(&template) != nil {
		return 500, nil
	}
	resources := []cacheResource{}
	var walk func(any, []string) any
	walk = func(node any, path []string) any {
		if len(path) > 0 && path[len(path)-1] == "content" {
			if _, ok := node.(string); ok {
				raw, _ := json.Marshal(node)
				sha := byteDigest(raw)
				resource := cacheResource{Path: path, Revision: sha, SHA256: sha}
				if in.Known[cachePath(path)] != sha {
					resource.Content = &raw
				}
				resources = append(resources, resource)
				return nil
			}
		}
		switch value := node.(type) {
		case map[string]any:
			for key, child := range value {
				value[key] = walk(child, append(append([]string{}, path...), key))
			}
		case []any:
			for i, child := range value {
				value[i] = walk(child, append(append([]string{}, path...), fmt.Sprint(i)))
			}
		}
		return node
	}
	template = walk(template, nil)
	out, _ := json.Marshal(template)
	reply, _ := json.Marshal(map[string]any{"data": cacheReply{Protocol: in.Protocol, LocalContent: in.Protocol == 3, RequestID: in.RequestID, CheckedAt: time.Now().UTC(), ValidForMS: 30_000, Status: status, Body: out, Resources: resources}})
	return 200, reply
}

func TestValidatedCacheRealNativeLaunchAndOfflineRefusal(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a signed real binary")
	}
	rig := newProfRig(t, true, func(cfg *config.Config) { cfg.Orchestrator.CommunicatorCacheProtocol = ValidatedCacheProtocol })
	for _, label := range []string{"cold strict launch", "warm strict launch"} {
		out := rig.run(label, "claude", "run", "--minimal")
		if out.ExitCode != 0 || out.NativeAt <= 0 || out.count("/sync/cache") == 0 {
			t.Fatalf("%s: exit=%d native=%v\n%s", label, out.ExitCode, out.NativeAt, out.Stdout)
		}
	}
	socket, err := socketPath(rig.srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	res, err := unixClient(socket, time.Second).Get("http://communicator.local/_comm/status")
	if err != nil {
		t.Fatal(err)
	}
	var status struct{ Cache struct{ Hits uint64 } }
	if err := json.NewDecoder(res.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if status.Cache.Hits == 0 {
		t.Fatal("real warm launch reused no RAM bytes")
	}
	rig.api.configure(func(a *profAPI) { a.cacheFailure = true })
	refused := rig.run("offline strict launch", "claude", "run", "--minimal")
	if refused.ExitCode == 0 || refused.NativeAt != 0 {
		t.Fatalf("offline cache launched native: exit=%d native=%v\n%s", refused.ExitCode, refused.NativeAt, refused.Stdout)
	}
	if _, err := os.Stat(filepath.Join(rig.root, "native-start.ts")); !os.IsNotExist(err) {
		t.Fatalf("offline launch left a native marker: %v", err)
	}
}

func cacheFixture(t *testing.T, input frame, content string, mutate func(*cacheReply)) frame {
	t.Helper()
	var request cacheRead
	if err := json.Unmarshal(input.Body, &request); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(content)
	path := []string{"content"}
	resource := cacheResource{Path: path, Revision: byteDigest(raw), SHA256: byteDigest(raw)}
	if request.Known[cachePath(path)] != resource.SHA256 {
		resource.Content = &raw
	}
	out := cacheReply{Protocol: 2, RequestID: request.RequestID, CheckedAt: time.Now().UTC(), ValidForMS: 30_000, Status: 200,
		Headers: map[string]string{"content-type": "application/json"}, Body: json.RawMessage(`{"content":null,"request":"fresh"}`), Resources: []cacheResource{resource}}
	if mutate != nil {
		mutate(&out)
	}
	body, err := json.Marshal(map[string]any{"data": out})
	if err != nil {
		t.Fatal(err)
	}
	return frame{Status: 200, Body: body}
}

func TestValidatedCacheRequiresEveryConfirmation(t *testing.T) {
	var cache validatedRAM
	calls := 0
	content := "first"
	source := frame{Method: "POST", Path: "/config/retrieve", Headers: map[string]string{"x-engine": "codex"}, Body: []byte(`{"home":"/native"}`)}
	exchange := func(_ context.Context, in frame) (frame, bool, error) {
		calls++
		return cacheFixture(t, in, content, nil), false, nil
	}
	for i := 0; i < 2; i++ {
		out, _, err := cache.read(context.Background(), source, exchange)
		if err != nil || !strings.Contains(string(out.Body), `"content":"first"`) {
			t.Fatalf("read %d: %s %v", i, out.Body, err)
		}
	}
	if calls != 2 || cache.hits != 1 || cache.misses != 1 {
		t.Fatalf("calls=%d cache=%+v", calls, cache.status())
	}
	// No push arrives: authoritative validation must still detect the new bytes.
	content = "second"
	out, _, err := cache.read(context.Background(), source, exchange)
	if err != nil || !strings.Contains(string(out.Body), `"content":"second"`) {
		t.Fatalf("lost push: %s %v", out.Body, err)
	}
	_, _, err = cache.read(context.Background(), source, func(context.Context, frame) (frame, bool, error) { return frame{}, false, errors.New("offline") })
	if err == nil {
		t.Fatal("offline read served cached content")
	}
}

func TestValidatedCacheConcurrentMissesFetchBytesOnceAndConfirmEachRead(t *testing.T) {
	var cache validatedRAM
	entered, open := make(chan struct{}), make(chan struct{})
	done := make(chan error, 2)
	calls, transfers := 0, 0
	exchange := func(_ context.Context, in frame) (frame, bool, error) {
		calls++
		if calls == 1 {
			close(entered)
			<-open
		}
		out := cacheFixture(t, in, "one copy", nil)
		var reply struct{ Data cacheReply }
		_ = json.Unmarshal(out.Body, &reply)
		if reply.Data.Resources[0].Content != nil {
			transfers++
		}
		return out, false, nil
	}
	f := frame{Method: "GET", Path: "/skills"}
	go func() { _, _, err := cache.read(context.Background(), f, exchange); done <- err }()
	<-entered
	go func() { _, _, err := cache.read(context.Background(), f, exchange); done <- err }()
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := cache.read(cancelled, f, exchange); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled waiter: %v", err)
	}
	close(open)
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if calls != 2 || transfers != 1 || len(cache.gates) != 0 {
		t.Fatalf("calls=%d transfers=%d gates=%d", calls, transfers, len(cache.gates))
	}
}

func TestValidatedCacheRejectsUnprovenResponses(t *testing.T) {
	for name, mutate := range map[string]func(*cacheReply){
		"wrong correlation":      func(r *cacheReply) { r.RequestID = "another-request" },
		"old protocol":           func(r *cacheReply) { r.Protocol = 1 },
		"expired confirmation":   func(r *cacheReply) { r.ValidForMS = 0 },
		"unbounded confirmation": func(r *cacheReply) { r.ValidForMS = 30_001 },
		"corrupt bytes":          func(r *cacheReply) { v := []byte(`"wrong"`); r.Resources[0].Content = &v },
		"unknown bytes":          func(r *cacheReply) { r.Resources[0].Content = nil },
		"expired resource":       func(r *cacheReply) { v := r.CheckedAt.Format(time.RFC3339Nano); r.Resources[0].ValidUntil = &v },
		"duplicate resource":     func(r *cacheReply) { r.Resources = append(r.Resources, r.Resources[0]) },
		"occupied template":      func(r *cacheReply) { r.Body = json.RawMessage(`{"content":"occupied"}`) },
	} {
		t.Run(name, func(t *testing.T) {
			var cache validatedRAM
			_, _, err := cache.read(context.Background(), frame{Method: "GET", Path: "/skills"}, func(_ context.Context, in frame) (frame, bool, error) {
				return cacheFixture(t, in, "secret", mutate), false, nil
			})
			if err == nil || len(cache.reads) > 0 {
				t.Fatalf("unproven response retained: %v %+v", err, cache.status())
			}
		})
	}
}

func TestValidatedCacheDeadlineConsumesTransitTime(t *testing.T) {
	var cache validatedRAM
	_, _, err := cache.read(context.Background(), frame{Method: "GET", Path: "/skills"}, func(_ context.Context, in frame) (frame, bool, error) {
		result := cacheFixture(t, in, "expired in flight", func(r *cacheReply) { r.ValidForMS = 1 })
		time.Sleep(3 * time.Millisecond)
		return result, false, nil
	})
	if err == nil {
		t.Fatal("expired in-flight confirmation served")
	}
}

func TestValidatedCacheOrderingIsolationAndRestart(t *testing.T) {
	var cache validatedRAM
	old, _ := cache.snapshot("scope", time.Now())
	newer, _ := cache.snapshot("scope", time.Now())
	cache.replace("scope", newer, map[string]cachedBytes{"p": {raw: []byte(`"new"`), sha: "new"}}, 0, 1)
	cache.replace("scope", old, map[string]cachedBytes{"p": {raw: []byte(`"old"`), sha: "old"}}, 0, 1)
	_, snapshot := cache.snapshot("scope", time.Now())
	if snapshot["p"].sha != "new" {
		t.Fatal("late old reply overwrote new generation")
	}
	_, other := cache.snapshot("another-scope", time.Now())
	if len(other) != 0 {
		t.Fatal("scope leak")
	}
	restarted := validatedRAM{}
	_, other = restarted.snapshot("scope", time.Now())
	if len(other) != 0 {
		t.Fatal("cache survived restart")
	}
	base := frame{Method: "POST", Path: "/auth", Headers: map[string]string{"authorization": "host-one"}}
	original := cacheKey(base, map[string]json.RawMessage{"engine": json.RawMessage(`"codex"`), "account_id": json.RawMessage(`1`)})
	for _, body := range []map[string]json.RawMessage{
		{"engine": json.RawMessage(`"claude"`), "account_id": json.RawMessage(`1`)},
		{"engine": json.RawMessage(`"codex"`), "account_id": json.RawMessage(`2`)},
		{"engine": json.RawMessage(`"codex"`), "account_id": json.RawMessage(`1`), "home": json.RawMessage(`"/other"`)},
	} {
		if cacheKey(base, body) == original {
			t.Fatal("binding collision")
		}
	}
}

func TestValidatedCacheMcpPreservesFreshRPCID(t *testing.T) {
	var cache validatedRAM
	for _, id := range []string{"9007199254740993123", "9007199254740993124"} {
		f := frame{Method: "POST", Path: "/mcp", Body: []byte(`{"jsonrpc":"2.0","id":` + id + `,"method":"tools/call","params":{"name":"skill_retrieve","arguments":{"slug":"sample"}}}`)}
		if !cacheCandidate(f) {
			t.Fatal("skill read not eligible")
		}
		out, _, err := cache.read(context.Background(), f, func(_ context.Context, in frame) (frame, bool, error) {
			return cacheFixture(t, in, "skill", func(r *cacheReply) { r.Body = json.RawMessage(`{"content":null,"id":` + id + `}`) }), false, nil
		})
		if err != nil || !strings.Contains(string(out.Body), id) {
			t.Fatalf("RPC correlation: %s %v", out.Body, err)
		}
	}
	if cache.hits != 1 {
		t.Fatal("RPC ID prevented byte reuse")
	}
	for _, body := range []string{
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"secret_get"}}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"resource_read","arguments":{"uri":"secret://anything"}}}`,
		`{"command":"store"}`,
	} {
		if cacheCandidate(frame{Method: "POST", Path: "/mcp", Body: []byte(body)}) {
			t.Fatal("arbitrary MCP cached")
		}
	}
}
