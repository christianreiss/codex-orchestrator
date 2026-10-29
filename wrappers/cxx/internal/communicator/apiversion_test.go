package communicator

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

func TestAPIContractFixtureParses(t *testing.T) {
	raw, err := os.ReadFile("testdata/api_contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name  string          `json:"name"`
			Frame bool            `json:"frame"`
			Body  json.RawMessage `json:"body"`
			Want  APILevels       `json:"want"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("empty contract fixture")
	}
	for _, tc := range fixture.Cases {
		if got := ParseAPILevels(tc.Body); got != tc.Want {
			t.Errorf("%s: got %+v, want %+v", tc.Name, got, tc.Want)
		}
		if !tc.Frame {
			continue
		}
		// A control frame decodes without failing (a malformed level must
		// never drop the connection) and yields the same levels.
		var f frame
		if err := json.Unmarshal(tc.Body, &f); err != nil {
			t.Errorf("%s: frame decode failed: %v", tc.Name, err)
		} else if got := f.apiLevels(); got != tc.Want {
			t.Errorf("%s: frame levels %+v, want %+v", tc.Name, got, tc.Want)
		}
	}
}

func TestParseAPILevelIsTolerant(t *testing.T) {
	for raw, want := range map[string]int{
		``: 0, `null`: 0, `"3"`: 0, `1.5`: 0, `1e2`: 0, `-2`: 0, `0`: 0, `true`: 0, `{}`: 0, `[1]`: 0,
		`99999999999999999999`: 0, strconv.Itoa(maxAPILevel + 1): 0,
		`1`: 1, ` 7 `: 7, strconv.Itoa(maxAPILevel): maxAPILevel,
	} {
		if got := ParseAPILevel(json.RawMessage(raw)); got != want {
			t.Errorf("ParseAPILevel(%q) = %d, want %d", raw, got, want)
		}
	}
	if got := ParseAPILevels([]byte(`not json`)); got.Declared() {
		t.Fatalf("garbage body declared %+v", got)
	}
}

func TestAPIPolicySemantics(t *testing.T) {
	cases := []struct {
		c      int
		levels APILevels
		want   string
	}{
		{1, APILevels{}, APIStateUnknown},
		{1, APILevels{Server: 3, Min: 2}, APIStateUpdateRequired},
		{2, APILevels{Server: 3, Min: 2}, APIStateUpdateQueued},
		{3, APILevels{Server: 3, Min: 2}, APIStateCurrent},
		{4, APILevels{Server: 3, Min: 2}, APIStateCurrent},
		{1, APILevels{Min: 2}, APIStateUpdateRequired},
		{1, APILevels{Server: 2}, APIStateUpdateQueued},
		// An inconsistent declaration (min above current) still enforces the minimum.
		{2, APILevels{Server: 2, Min: 3}, APIStateUpdateRequired},
	}
	for _, tc := range cases {
		if got := APIPolicy(tc.c, tc.levels); got != tc.want {
			t.Errorf("APIPolicy(%d, %+v) = %s, want %s", tc.c, tc.levels, got, tc.want)
		}
	}
}

func TestAPIViewReportsBackoffOnlyBelowMinimum(t *testing.T) {
	until := time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC)
	below := APILevels{Server: APIVersion + 2, Min: APIVersion + 1}
	st := apiView(below, APIBackoff{Until: until, Reason: "no_newer_release"})
	if st.State != APIStateBackoff || st.NextAttempt != "2026-10-29T08:00:00Z" || st.Remedy == "" || st.Version != APIVersion || st.MinAPI != APIVersion+1 {
		t.Fatalf("backoff view = %+v", st)
	}
	if st := apiView(below, APIBackoff{}); st.State != APIStateUpdateRequired || st.NextAttempt != "" {
		t.Fatalf("required view = %+v", st)
	}
	// A stale backoff never colours a level that is no longer below the minimum.
	if st := apiView(APILevels{Server: APIVersion + 1, Min: APIVersion}, APIBackoff{Until: until}); st.State != APIStateUpdateQueued {
		t.Fatalf("queued view = %+v", st)
	}
	if st := apiView(APILevels{}, APIBackoff{}); st.State != APIStateUnknown || st.ServerVersion != 0 {
		t.Fatalf("absent view = %+v", st)
	}
}

func TestObserveAPIReplacesOnReadyAndRefinesOnHeartbeat(t *testing.T) {
	s := &server{updateTrigger: make(chan struct{}, 1)}
	drain := func() bool {
		select {
		case <-s.updateTrigger:
			return true
		default:
			return false
		}
	}
	s.observeAPI(APILevels{Server: 2, Min: 1}, true)
	if s.apiSnapshot() != (APILevels{Server: 2, Min: 1}) || !s.apiHello.Load() || !drain() {
		t.Fatal("a ready declaration must be stored, enable the hello field and wake the updater")
	}
	s.observeAPI(APILevels{}, false)
	if s.apiSnapshot() != (APILevels{Server: 2, Min: 1}) || drain() {
		t.Fatal("a heartbeat without fields must neither clear the levels nor wake the updater")
	}
	s.observeAPI(APILevels{Server: 2, Min: 1}, false)
	if drain() {
		t.Fatal("an unchanged declaration must not wake the updater")
	}
	s.observeAPI(APILevels{Server: 3, Min: 2}, false)
	if s.apiSnapshot() != (APILevels{Server: 3, Min: 2}) || !drain() {
		t.Fatal("a heartbeat with new levels must refine and wake")
	}
	// A rolled-back server's ready frame clears the stale minimum (fail open).
	s.observeAPI(APILevels{}, true)
	if s.apiSnapshot().Declared() || s.apiHello.Load() || !drain() {
		t.Fatal("an authoritative frame without fields must clear the declaration")
	}
}

// The control connection reads the declaration from ready and heartbeat
// frames, sends X-Cxx-Api on the upgrade, and survives malformed values.
func TestConnectionObservesAPIAndSurvivesMalformedFields(t *testing.T) {
	var header string
	var mu sync.Mutex
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		header = r.Header.Get(APIHeader)
		mu.Unlock()
		websocket.Handler(func(ws *websocket.Conn) {
			defer ws.Close()
			for _, raw := range []string{
				`{"type":"ready","protocol":1,"control":[],"api_version":"2","min_api":{"x":1}}`,
				`{"type":"heartbeat","api_version":3,"min_api":2}`,
				`{"type":"pong","api_version":1.5}`,
			} {
				if websocket.Message.Send(ws, raw) != nil {
					return
				}
			}
			for {
				var f frame
				if websocket.JSON.Receive(ws, &f) != nil {
					return
				}
				websocket.JSON.Send(ws, frame{ID: f.ID, Status: 200, Body: []byte("ok")})
			}
		}).ServeHTTP(w, r)
	}))
	defer remote.Close()
	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: remote.URL, APIKey: "test"}}
	transport, err := directTransport(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ws, err := dial(context.Background(), cfg, transport)
	if err != nil {
		t.Fatal(err)
	}
	type seen struct {
		levels        APILevels
		authoritative bool
	}
	observed := make(chan seen, 8)
	c := &connection{ws: ws, pending: map[string]chan frame{}, done: make(chan struct{}), ready: make(chan struct{}),
		apiObserved: func(l APILevels, a bool) { observed <- seen{l, a} }}
	go c.receive()
	defer func() { ws.Close(); <-c.done }()
	want := []seen{{APILevels{}, true}, {APILevels{Server: 3, Min: 2}, false}, {APILevels{}, false}}
	for i, w := range want {
		select {
		case got := <-observed:
			if got != w {
				t.Fatalf("observation %d = %+v, want %+v", i, got, w)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("observation %d never arrived", i)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	reply, _, err := c.request(ctx, frame{Method: "GET", Path: "/versions"})
	if err != nil || string(reply.Body) != "ok" {
		t.Fatalf("connection did not survive malformed fields: %v %q", err, reply.Body)
	}
	mu.Lock()
	defer mu.Unlock()
	if header != strconv.Itoa(APIVersion) {
		t.Fatalf("upgrade %s = %q, want %d", APIHeader, header, APIVersion)
	}
}

func TestOwnerStatusCarriesTheAPIBlock(t *testing.T) {
	s := &server{calls: map[string]*sharedCall{}, apiLevels: APILevels{Server: APIVersion + 1, Min: APIVersion + 1}, apiBackoff: APIBackoff{Until: time.Date(2026, 10, 29, 9, 0, 0, 0, time.UTC), Reason: "no_newer_release"}}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "http://communicator.local/_comm/status", nil))
	var status struct {
		API APIStatus `json:"api"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err, rec.Body.String())
	}
	if status.API.State != APIStateBackoff || status.API.Version != APIVersion || status.API.ServerVersion != APIVersion+1 || status.API.NextAttempt != "2026-10-29T09:00:00Z" || status.API.Remedy == "" {
		t.Fatalf("api block = %+v", status.API)
	}
}

// statusReportFor runs statusReport against one stub owner answering status.
func statusReportFor(t *testing.T, status map[string]any) bool {
	t.Helper()
	dir, err := os.MkdirTemp("", "cxa")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	saved := map[any]any{}
	registry.Range(func(k, v any) bool { saved[k] = v; registry.Delete(k); return true })
	defer func() {
		registry.Range(func(k, _ any) bool { registry.Delete(k); return true })
		for k, v := range saved {
			registry.Store(k, v)
		}
	}()
	base := "https://api-floor.example"
	status["server"] = base
	body, _ := json.Marshal(status)
	registry.Store(base, &endpoint{base: base, socket: ownerSocket(t, dir, "o.sock", statusBody(string(body)))})
	var out bytes.Buffer
	failed := statusReport(&out, "dev")
	if line := statusLineFor(t, out.String(), base); line["api"] == nil {
		t.Fatalf("api block missing from status: %s", out.String())
	}
	return failed
}

func TestStatusReportFailsDoctorOnlyForAPIBackoff(t *testing.T) {
	for _, tc := range []struct {
		state  string
		failed bool
	}{{APIStateBackoff, true}, {APIStateUpdateRequired, false}, {APIStateUpdateQueued, false}, {APIStateCurrent, false}, {APIStateUnknown, false}} {
		status := map[string]any{"connected": true, "version": "dev", "api": map[string]any{"state": tc.state}}
		if got := statusReportFor(t, status); got != tc.failed {
			t.Errorf("api.state %s: failed=%v, want %v", tc.state, got, tc.failed)
		}
	}
}
