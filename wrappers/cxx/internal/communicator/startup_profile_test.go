package communicator

// Opt-in startup-stage profile (measurement only, no production code touched):
//
//	CXX_STARTUP_PROFILE=1 go test ./internal/communicator -run TestStartupProfile -count=1 -v
//
// It builds the real cxx binary from CXX_STARTUP_PROFILE_SRC (default: this
// tree) with a throwaway signing key, runs the real `claude sync` against an
// in-process stub API in an isolated HOME/XDG/runtime root, and reports where a
// launch's wall time goes: gate wait + worker spawn, API frames (count, bytes,
// injected latency) and local apply. Content is generated to match the managed
// fleet set measured on biest (46 skills / 125 files / ~318 KB by default).
//
// Knobs: CXX_STARTUP_PROFILE_LATENCY_MS (per API frame, default 0),
// _SKILLS/_FILES/_BYTES (content shape), _RUNS (warm repetitions),
// _COMM=0 (legacy transport: direct HTTP, no owner), _OUT (JSON result file).
// Stub timings are not production timings: the stub has no database, no event
// loop contention and a fixed injected latency.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

type profFile struct {
	Path, Content string
}
type profSkill struct {
	Slug         string
	Content      string
	Files        []profFile
	Bundle       bool
	SHA          string // bundle digest (wrapper compares against this)
	ManifestSHA  string
	approxFrames int
}

type profEvent struct {
	At        time.Duration `json:"at_ms"`
	Path      string        `json:"path"`
	Transport string        `json:"transport"`
	ReqBytes  int           `json:"req_bytes"`
	RespBytes int           `json:"resp_bytes"`
	Dur       time.Duration `json:"dur_ms"`
}

type profAPI struct {
	mu       sync.Mutex
	start    time.Time
	events   []profEvent
	latency  time.Duration
	byPath   map[string]time.Duration
	connect  time.Duration // delay before the communicator WebSocket upgrade completes
	conns    []*websocket.Conn
	arrived  map[string]int // requests that reached a route, counted before any injected delay
	skills   []profSkill
	agents   string
	root     string
	priv     ed25519.PrivateKey
	comm     bool
	frameOut chan frame
	// contentless counts bootstraps that asked for include_content:false.
	contentless int
}

func profDigest(s string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(s))) }

// profContent generates deterministic fleet-shaped skills: every skill has a
// SKILL.md, and `files-skills` auxiliary files are spread over a minority of
// bundle skills, as in the managed mattpocock set.
func profContent(skills, files, totalBytes int) []profSkill {
	rng := rand.New(rand.NewSource(20261013))
	aux := files - skills
	if aux < 0 {
		aux = 0
	}
	bundles := skills / 3
	if bundles == 0 {
		bundles = 1
	}
	perBundle := make([]int, skills)
	for i := 0; i < aux; i++ {
		perBundle[rng.Intn(bundles)]++
	}
	weights := make([]float64, 0, files)
	for i := 0; i < files; i++ {
		weights = append(weights, rng.ExpFloat64()+0.15)
	}
	sum := 0.0
	for _, w := range weights {
		sum += w
	}
	next := 0
	size := func() int {
		n := int(weights[next%len(weights)] / sum * float64(totalBytes))
		next++
		if n < 64 {
			n = 64
		}
		return n
	}
	text := func(n int) string {
		const alphabet = "abcdefghijklmnopqrstuvwxyz      \n"
		b := make([]byte, n)
		for i := range b {
			b[i] = alphabet[rng.Intn(len(alphabet))]
		}
		return string(b)
	}
	out := make([]profSkill, 0, skills)
	for i := 0; i < skills; i++ {
		s := profSkill{Slug: fmt.Sprintf("fixture-skill-%02d", i)}
		s.Content = "---\nname: " + s.Slug + "\ndescription: generated\n---\n" + text(size())
		s.ManifestSHA = profDigest(s.Content)
		if perBundle[i] > 0 {
			s.Bundle = true
			hashes := map[string]string{}
			for j := 0; j < perBundle[i]; j++ {
				f := profFile{Path: fmt.Sprintf("references/ref-%02d.md", j), Content: text(size())}
				s.Files = append(s.Files, f)
				hashes[f.Path] = profDigest(f.Content)
			}
			s.SHA = profBundleDigest(s.ManifestSHA, hashes)
		} else {
			s.SHA = s.ManifestSHA
		}
		out = append(out, s)
	}
	return out
}

// profBundleDigest mirrors lifecycle.canonicalSkillBundleDigest (unexported there).
func profBundleDigest(manifest string, files map[string]string) string {
	type entry struct{ path, sha string }
	entries := []entry{{"SKILL.md", strings.ToLower(manifest)}}
	for p, h := range files {
		entries = append(entries, entry{p, strings.ToLower(h)})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].path < entries[j].path })
	h := sha256.New()
	for _, e := range entries {
		h.Write([]byte(e.path))
		h.Write([]byte{0})
		h.Write([]byte(e.sha))
		h.Write([]byte{'\n'})
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}

func (a *profAPI) record(path, transport string, req, resp int, begin time.Time) {
	a.mu.Lock()
	a.events = append(a.events, profEvent{At: begin.Sub(a.start), Path: strings.Split(path, "?")[0], Transport: transport, ReqBytes: req, RespBytes: resp, Dur: time.Since(begin)})
	a.mu.Unlock()
}

func (a *profAPI) handle(method, path string, body []byte) (int, []byte) {
	route := strings.Split(path, "?")[0]
	a.mu.Lock()
	if a.arrived == nil {
		a.arrived = map[string]int{}
	}
	a.arrived[route]++
	delay, ok := a.byPath[route]
	if !ok {
		delay = a.latency
	}
	a.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	switch route {
	case "/wrapper/v2/config":
		u, _ := url.Parse(path)
		raw, err := os.ReadFile(filepath.Join(a.root, u.Query().Get("engine")+".json"))
		if err != nil {
			return 404, []byte(`{"error":{"code":"not_found"}}`)
		}
		out, _ := json.Marshal(map[string]any{"payload": json.RawMessage(raw), "signature": map[string]string{"value": base64.StdEncoding.EncodeToString(ed25519.Sign(a.priv, raw))}})
		return 200, out
	case "/sync/bootstrap":
		var req struct {
			Engine      string                       `json:"engine"`
			IncludeAuth bool                         `json:"include_auth"`
			AuthDigest  string                       `json:"auth_digest"`
			Agents      string                       `json:"agents"`
			Config      string                       `json:"config"`
			Artifacts   map[string]map[string]string `json:"artifacts"`
			Content     *bool                        `json:"include_content"`
		}
		_ = json.Unmarshal(body, &req)
		if req.Content != nil && !*req.Content {
			a.mu.Lock()
			a.contentless++
			a.mu.Unlock()
			data := map[string]any{"status": "ok", "content": "omitted", "host": map[string]any{"secure": true}}
			if req.IncludeAuth {
				data["auth"] = map[string]any{"status": "valid", "digest": req.AuthDigest, "canonical_digest": req.AuthDigest, "verification_state": "verified", "engine": "claude", "host": map[string]any{"secure": true}}
			}
			out, _ := json.Marshal(map[string]any{"status": "ok", "data": data})
			return 200, out
		}
		have := req.Artifacts["skill"]
		items := make([]map[string]any, 0, len(a.skills))
		for _, s := range a.skills {
			if have[s.Slug] == s.SHA {
				items = append(items, map[string]any{"slug": s.Slug, "sha256": s.SHA, "status": "unchanged"})
				continue
			}
			item := map[string]any{"slug": s.Slug, "sha256": s.SHA, "status": "updated", "content": s.Content}
			if s.Bundle {
				files := make([]map[string]string, 0, len(s.Files))
				for _, f := range s.Files {
					files = append(files, map[string]string{"path": f.Path, "sha256": profDigest(f.Content), "content": f.Content})
				}
				item["manifest_sha256"] = s.ManifestSHA
				item["files"] = files
			}
			items = append(items, item)
		}
		data := map[string]any{"status": "ok", "claude_skills": items, "claude_artifacts": map[string]any{"subagent": []any{}, "command": []any{}, "output-style": []any{}}, "claude_settings": map[string]any{"status": "unchanged"}, "host": map[string]any{"secure": true}}
		if req.Agents != profDigest(a.agents) {
			data["agents"] = map[string]any{"content": a.agents}
		}
		if req.IncludeAuth {
			// A healthy host: the canonical head is whatever the host already holds.
			data["auth"] = map[string]any{"status": "valid", "digest": req.AuthDigest, "canonical_digest": req.AuthDigest, "verification_state": "verified", "engine": "claude", "host": map[string]any{"secure": true}}
		}
		out, _ := json.Marshal(map[string]any{"status": "ok", "data": data})
		return 200, out
	case "/auth":
		var req struct {
			Digest string `json:"digest"`
		}
		_ = json.Unmarshal(body, &req)
		out, _ := json.Marshal(map[string]any{"status": "valid", "digest": req.Digest, "canonical_digest": req.Digest, "verification_state": "verified", "engine": "claude", "host": map[string]any{"secure": true}})
		return 200, out
	}
	return 200, []byte(`{"status":"ok","data":{}}`)
}

// arrivals counts requests that reached route, including ones still being served.
func (a *profAPI) arrivals(route string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.arrived[route]
}

// configure changes the stub's behavior while it serves.
func (a *profAPI) configure(change func(*profAPI)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	change(a)
}

// dropConnections closes every communicator WebSocket from the server side, as a
// network blip or an API restart would.
func (a *profAPI) dropConnections() {
	a.mu.Lock()
	conns := a.conns
	a.conns = nil
	a.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}

// push sends a server-initiated frame (an invalidation, as the API fan-out does).
func (a *profAPI) push(f frame) {
	a.mu.Lock()
	out := a.frameOut
	a.mu.Unlock()
	if out != nil {
		select {
		case out <- f:
		default:
		}
	}
}

func (a *profAPI) delayed(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		delay := a.connect
		a.mu.Unlock()
		if delay > 0 {
			time.Sleep(delay)
		}
		next.ServeHTTP(w, r)
	})
}

func (a *profAPI) server() *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		begin := time.Now()
		body := bytes.NewBuffer(nil)
		_, _ = body.ReadFrom(r.Body)
		status, out := a.handle(r.Method, r.URL.RequestURI(), body.Bytes())
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(out)
		a.record(r.URL.Path, "http", body.Len(), len(out), begin)
	})
	mux.Handle("/host/communicator/connect", a.delayed(websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var writes sync.Mutex
		send := func(f frame) { writes.Lock(); defer writes.Unlock(); _ = websocket.JSON.Send(ws, f) }
		var wg sync.WaitGroup
		defer wg.Wait()
		a.mu.Lock()
		a.conns = append(a.conns, ws)
		a.frameOut = make(chan frame, 16)
		out := a.frameOut
		a.mu.Unlock()
		go func() {
			for f := range out {
				send(f)
			}
		}()
		for {
			var f frame
			if websocket.JSON.Receive(ws, &f) != nil {
				return
			}
			switch f.Type {
			case "hello":
				send(frame{Type: "ready", Protocol: 1})
			case "heartbeat":
				send(frame{Type: "heartbeat"})
			case "request":
				wg.Add(1)
				go func(f frame) {
					defer wg.Done()
					begin := time.Now()
					status, body := a.handle(f.Method, f.Path, f.Body)
					send(frame{ID: f.ID, Status: status, Body: body, Headers: map[string]string{"content-type": "application/json"}})
					a.record(f.Path, "ws", len(f.Body), len(body), begin)
				}(f)
			}
		}
	})))
	return httptest.NewServer(mux)
}

type profRig struct {
	t       *testing.T
	root    string
	runtime string
	binary  string
	api     *profAPI
	srv     *httptest.Server
	env     []string
	cfgPath string
}

func profBuild(t *testing.T, src, out, key string) {
	t.Helper()
	build := exec.Command("go", "build", "-o", out, "-ldflags", "-X github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing.buildPublicKeyB64="+key, "./cmd/cxx")
	build.Dir = src
	if raw, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build %s: %v\n%s", src, err, raw)
	}
}

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil {
		return v
	}
	return def
}

func newProfRig(t *testing.T, comm bool, adjust ...func(*config.Config)) *profRig {
	t.Helper()
	root := t.TempDir()
	runtime, err := os.MkdirTemp("", "cc-prof-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(runtime) })
	// socketPath derives the owner socket from the process environment; keep that
	// pointing at this rig for the test and restore it afterwards, so a later call
	// cannot recreate the directory after cleanup.
	t.Setenv("XDG_RUNTIME_DIR", runtime)
	pub, priv, _ := ed25519.GenerateKey(cryptorand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	key := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	src := os.Getenv("CXX_STARTUP_PROFILE_SRC")
	if src == "" {
		src = "../.."
	}
	binary := filepath.Join(root, "cxx")
	profBuild(t, src, binary, key)
	api := &profAPI{start: time.Now(), latency: time.Duration(envInt("CXX_STARTUP_PROFILE_LATENCY_MS", 0)) * time.Millisecond, root: root, priv: priv, comm: comm}
	// CXX_STARTUP_PROFILE_LATENCY_MAP="/sync/bootstrap=5500,/auth=1500": per-route server time in ms.
	for _, pair := range strings.Split(os.Getenv("CXX_STARTUP_PROFILE_LATENCY_MAP"), ",") {
		if k, v, ok := strings.Cut(strings.TrimSpace(pair), "="); ok {
			if n, err := strconv.Atoi(v); err == nil {
				if api.byPath == nil {
					api.byPath = map[string]time.Duration{}
				}
				api.byPath[k] = time.Duration(n) * time.Millisecond
			}
		}
	}
	api.connect = time.Duration(envInt("CXX_STARTUP_PROFILE_CONNECT_MS", 0)) * time.Millisecond
	api.skills = profContent(envInt("CXX_STARTUP_PROFILE_SKILLS", 46), envInt("CXX_STARTUP_PROFILE_FILES", 125), envInt("CXX_STARTUP_PROFILE_BYTES", 318000))
	api.agents = "# managed CLAUDE.md\n" + strings.Repeat("fleet policy line\n", 1700)
	srv := api.server()
	t.Cleanup(srv.Close)
	hostname, _ := os.Hostname()
	protocol, syncProtocol := 0, 0
	if comm {
		protocol, syncProtocol = 1, 1
	}
	cfg := config.Config{SchemaVersion: 1, Engine: "claude", IssuedAt: "2026-10-13T00:00:00Z", Orchestrator: config.Orchestrator{BaseURL: srv.URL, APIKey: "fixture-host-key", InstallationID: "fixture", CommunicatorProtocol: protocol, CommunicatorSyncProtocol: syncProtocol}, Host: config.Host{ID: 1, FQDN: hostname, Secure: true}, Wrapper: config.Wrapper{Version: "0.9.76", Track: "stable", BinaryURL: srv.URL + "/download", BinarySHA256: strings.Repeat("0", 64)}}
	for _, change := range adjust {
		change(&cfg)
	}
	path := filepath.Join(root, "claude.json")
	raw, _ := json.Marshal(cfg)
	_ = os.WriteFile(path, raw, 0600)
	_ = os.WriteFile(path+".sig", ed25519.Sign(priv, raw), 0600)
	credentials := filepath.Join(root, ".claude", ".credentials.json")
	_ = os.MkdirAll(filepath.Dir(credentials), 0o700)
	_ = os.WriteFile(credentials, []byte(fmt.Sprintf(`{"last_refresh":%q,"claudeAiOauth":{"accessToken":"fixture-access","refreshToken":"fixture-refresh","expiresAt":%d}}`, time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano), time.Now().Add(6*time.Hour).UnixMilli())), 0o600)
	fake := filepath.Join(root, "fake-claude")
	_ = os.WriteFile(fake, []byte("#!/bin/sh\ndate +%s%N > \""+filepath.Join(root, "native-start.ts")+"\"\nexit 0\n"), 0o755)
	env := append(communicatorEnvironment(os.Environ()), "HOME="+root, "XDG_RUNTIME_DIR="+runtime, "CLX_CONFIG_PATH="+path, "CLX_CLAUDE_BIN="+fake, "CLAUDE_ALLOW_FQDN_MISMATCH=1", "PATH=/usr/bin:/bin")
	rig := &profRig{t: t, root: root, runtime: runtime, binary: binary, api: api, srv: srv, env: env, cfgPath: path}
	// The owner outlives the launches by design (idle exit is five minutes). Stop
	// this rig's own owner and its workers before the temp HOME is removed, or a
	// late worker write races the cleanup.
	t.Cleanup(rig.stopOwner)
	return rig
}

// ownersOf lists the processes started with this rig's private runtime root. The
// root is unique per rig, so matching on it identifies exactly the rig's own
// owner and workers even when the owner is too busy to answer a status request.
func (p *profRig) ownersOf() []int {
	var pids []int
	entries, _ := os.ReadDir("/proc")
	want := "XDG_RUNTIME_DIR=" + p.runtime
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		env, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
		if err != nil {
			continue
		}
		for _, kv := range bytes.Split(env, []byte{0}) {
			if string(kv) == want {
				pids = append(pids, pid)
				break
			}
		}
	}
	return pids
}

func (p *profRig) stopOwner() {
	deadline := time.Now().Add(3 * time.Second)
	for {
		pids := p.ownersOf()
		if len(pids) == 0 {
			break
		}
		signal := syscall.SIGTERM
		if time.Now().After(deadline) {
			signal = syscall.SIGKILL
		}
		for _, pid := range pids {
			_ = syscall.Kill(pid, signal)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// An owner that is shutting down can still be creating its socket directory.
	for i := 0; i < 5; i++ {
		if os.RemoveAll(p.runtime) == nil {
			if _, err := os.Stat(p.runtime); os.IsNotExist(err) {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
}

type profRun struct {
	Label      string        `json:"label"`
	Wall       time.Duration `json:"wall_ms"`
	ExitCode   int           `json:"exit"`
	Frames     []profEvent   `json:"frames"`
	Workers    []profWorker  `json:"workers"`
	NativeAt   time.Duration `json:"native_exec_after_start_ms"`
	FirstFrame time.Duration `json:"first_frame_after_start_ms"`
	LastFrame  time.Duration `json:"last_frame_done_after_start_ms"`
	Stdout     string        `json:"-"`
}

type profWorker struct {
	First time.Duration `json:"first_seen_ms"`
	Last  time.Duration `json:"last_seen_ms"`
}

func (p *profRig) ownerPID() int {
	socket, err := socketPath(p.srv.URL)
	if err != nil {
		return 0
	}
	res, err := unixClient(socket, 500*time.Millisecond).Get("http://communicator.local/_comm/status")
	if err != nil {
		return 0
	}
	defer res.Body.Close()
	var status struct {
		PID int `json:"pid"`
	}
	_ = json.NewDecoder(res.Body).Decode(&status)
	return status.PID
}

// workerSampler records the lifetime of `communicator-worker` children of pid.
func workerSampler(ctx context.Context, owner func() int, begin time.Time) func() []profWorker {
	var mu sync.Mutex
	seen := map[int]*profWorker{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ctx.Err() == nil {
			pid := owner()
			if pid > 0 {
				tasks, _ := os.ReadDir(fmt.Sprintf("/proc/%d/task", pid))
				for _, task := range tasks {
					raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/task/%s/children", pid, task.Name()))
					if err != nil {
						continue
					}
					for _, field := range strings.Fields(string(raw)) {
						cmd, _ := os.ReadFile("/proc/" + field + "/cmdline")
						if !bytes.Contains(cmd, []byte("communicator-worker")) {
							continue
						}
						id, _ := strconv.Atoi(field)
						now := time.Since(begin)
						mu.Lock()
						if seen[id] == nil {
							seen[id] = &profWorker{First: now}
						}
						seen[id].Last = now
						mu.Unlock()
					}
				}
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()
	return func() []profWorker {
		<-done
		mu.Lock()
		defer mu.Unlock()
		out := make([]profWorker, 0, len(seen))
		for _, w := range seen {
			out = append(out, *w)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].First < out[j].First })
		return out
	}
}

func (p *profRig) run(label string, args ...string) profRun {
	p.t.Helper()
	p.api.mu.Lock()
	mark := len(p.api.events)
	p.api.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	_ = os.Remove(filepath.Join(p.root, "native-start.ts"))
	begin := time.Now()
	stop := workerSampler(ctx, p.ownerPID, begin)
	cmd := exec.Command(p.binary, args...)
	cmd.Env = p.env
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	runErr := cmd.Run()
	wall := time.Since(begin)
	cancel()
	workers := stop()
	code := 0
	if runErr != nil {
		code = -1
		if ee, ok := runErr.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
	}
	p.api.mu.Lock()
	frames := append([]profEvent(nil), p.api.events[mark:]...)
	p.api.mu.Unlock()
	r := profRun{Label: label, Wall: wall, ExitCode: code, Frames: frames, Workers: workers, Stdout: out.String()}
	if raw, err := os.ReadFile(filepath.Join(p.root, "native-start.ts")); err == nil {
		if ns, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64); err == nil {
			r.NativeAt = time.Unix(0, ns).Sub(begin)
		}
	}
	offset := begin.Sub(p.api.start)
	for i, f := range frames {
		f.At -= offset
		frames[i] = f
		if i == 0 || f.At < r.FirstFrame {
			r.FirstFrame = f.At
		}
		if end := f.At + f.Dur; end > r.LastFrame {
			r.LastFrame = end
		}
	}
	for i, w := range r.Workers {
		_ = i
		_ = w
	}
	return r
}

func (r profRun) timeline() string {
	var b strings.Builder
	for _, f := range r.Frames {
		fmt.Fprintf(&b, "      +%7.1fms %-4s %-26s dur=%6.1fms req=%dB resp=%dB\n", ms(f.At), f.Transport, f.Path, ms(f.Dur), f.ReqBytes, f.RespBytes)
	}
	for _, w := range r.Workers {
		fmt.Fprintf(&b, "      worker process seen +%7.1fms .. +%7.1fms\n", ms(w.First), ms(w.Last))
	}
	return strings.TrimRight(b.String(), "\n")
}

func (r profRun) summary() string {
	var b strings.Builder
	bytesIn := 0
	counts := map[string]int{}
	for _, f := range r.Frames {
		counts[f.Path]++
		bytesIn += f.RespBytes
	}
	paths := make([]string, 0, len(counts))
	for p := range counts {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		fmt.Fprintf(&b, " %s×%d", p, counts[p])
	}
	apply := time.Duration(0)
	if r.LastFrame > 0 && r.Wall > r.LastFrame {
		apply = r.Wall - r.LastFrame
	}
	line := fmt.Sprintf("%-34s wall=%7.1fms native@%7.1fms exit=%d workers=%d frames=%d resp=%dKB firstFrame=%6.1fms lastFrameDone=%6.1fms tail(after last frame)=%6.1fms |%s",
		r.Label, ms(r.Wall), ms(r.NativeAt), r.ExitCode, len(r.Workers), len(r.Frames), bytesIn/1024, ms(r.FirstFrame), ms(r.LastFrame), ms(apply), b.String())
	if os.Getenv("CXX_STARTUP_PROFILE_TIMELINE") == "1" {
		line += "\n" + r.timeline()
	}
	return line
}

func ms(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

// standingLeases holds n auth-session leases on the claude scope, like n running
// sessions sharing one HOME (biest: 24 leases over a handful of scopes).
func (p *profRig) standingLeases(n int) func() {
	p.t.Helper()
	socket, err := socketPath(p.srv.URL)
	if err != nil {
		p.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	var bodies []interface{ Close() error }
	for i := 0; i < n; i++ {
		job := syncJob{Engine: "claude", Config: p.cfgPath, Env: map[string]string{"HOME": p.root}, Owner: true, Auth: true, SessionID: fmt.Sprintf("standing-%d", i), AuthPath: filepath.Join(p.root, ".claude", ".credentials.json")}
		raw, _ := json.Marshal([]syncJob{job})
		req, _ := http.NewRequestWithContext(ctx, "POST", "http://communicator.local/_comm/lease", bytes.NewReader(raw))
		res, err := unixClient(socket, 0).Do(req)
		if err != nil || res.StatusCode != 200 {
			p.t.Fatalf("standing lease %d: %v", i, err)
		}
		bodies = append(bodies, res.Body)
	}
	return func() {
		cancel()
		for _, b := range bodies {
			_ = b.Close()
		}
	}
}

func (p *profRig) storm(every time.Duration) func() {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		for ctx.Err() == nil {
			time.Sleep(every)
			p.api.push(frame{Type: "invalidate"})
		}
	}()
	return cancel
}

func TestStartupProfile(t *testing.T) {
	if testing.Short() || os.Getenv("CXX_STARTUP_PROFILE") != "1" {
		t.Skip("opt-in: CXX_STARTUP_PROFILE=1")
	}
	comm := os.Getenv("CXX_STARTUP_PROFILE_COMM") != "0"
	rig := newProfRig(t, comm)
	skillFiles, skillBytes := 0, 0
	for _, s := range rig.api.skills {
		skillFiles += 1 + len(s.Files)
		skillBytes += len(s.Content)
		for _, f := range s.Files {
			skillBytes += len(f.Content)
		}
	}
	t.Logf("fixture: comm=%v latency=%v skills=%d files=%d bytes=%d agents=%dB src=%q", comm, rig.api.latency, len(rig.api.skills), skillFiles, skillBytes, len(rig.api.agents), os.Getenv("CXX_STARTUP_PROFILE_SRC"))
	var all []profRun
	launch := []string{"claude", "run", "--minimal"}
	cold := rig.run("cold owner + cold content", launch...)
	all = append(all, cold)
	t.Log(cold.summary())
	if cold.ExitCode != 0 {
		t.Logf("cold output: %s", cold.Stdout)
	}
	for i := 0; i < envInt("CXX_STARTUP_PROFILE_RUNS", 5); i++ {
		warm := rig.run(fmt.Sprintf("warm owner + warm content #%d", i+1), launch...)
		all = append(all, warm)
		t.Log(warm.summary())
		if warm.ExitCode != 0 {
			t.Logf("output: %s", warm.Stdout)
		}
	}
	if n := envInt("CXX_STARTUP_PROFILE_LEASES", 0); n > 0 {
		release := rig.standingLeases(n)
		defer release()
		time.Sleep(1500 * time.Millisecond) // let the new scope's own first pass finish
		for i := 0; i < envInt("CXX_STARTUP_PROFILE_RUNS", 5); i++ {
			r := rig.run(fmt.Sprintf("warm + %d standing leases #%d", n, i+1), launch...)
			all = append(all, r)
			t.Log(r.summary())
		}
		if every := envInt("CXX_STARTUP_PROFILE_STORM_MS", 0); every > 0 {
			stop := rig.storm(time.Duration(every) * time.Millisecond)
			for i := 0; i < envInt("CXX_STARTUP_PROFILE_RUNS", 5)*2; i++ {
				r := rig.run(fmt.Sprintf("launch under %dms invalidation storm #%d", every, i+1), launch...)
				all = append(all, r)
				t.Log(r.summary())
			}
			stop()
		}
	}
	if out := os.Getenv("CXX_STARTUP_PROFILE_OUT"); out != "" {
		raw, _ := json.MarshalIndent(all, "", "  ")
		_ = os.WriteFile(out, raw, 0o644)
	}
}

func (r profRun) count(path string) int {
	n := 0
	for _, f := range r.Frames {
		if f.Path == path {
			n++
		}
	}
	return n
}

func (p *profRig) frames(path string) int {
	p.api.mu.Lock()
	defer p.api.mu.Unlock()
	n := 0
	for _, f := range p.api.events {
		if f.Path == path {
			n++
		}
	}
	return n
}

// A launch into a fresh scope registers the scope (which makes the scheduler's
// own initial content pass due) and runs its own bootstrap. The two are the same
// exchange: once the launch's bootstrap has read server state, the queued
// scheduler pass must not repeat it in front of the launch's remaining calls.
func TestFreshScopeLaunchSharesOneContentExchange(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a signed real binary")
	}
	rig := newProfRig(t, true)
	// A cold owner's connection takes real time. The launch's worker starts before
	// it is up; the connect-time invalidation must not make that worker stale.
	rig.api.configure(func(a *profAPI) {
		a.byPath = map[string]time.Duration{"/sync/bootstrap": 400 * time.Millisecond}
		a.connect = 300 * time.Millisecond
	})
	launch := rig.run("fresh scope launch", "claude", "run", "--minimal")
	if launch.ExitCode != 0 {
		t.Fatalf("launch failed: %s", launch.Stdout)
	}
	if got := launch.count("/sync/bootstrap"); got != 1 {
		t.Fatalf("a fresh-scope launch must perform one bundle exchange, got %d\n%s", got, launch.timeline())
	}
	warm := rig.run("second launch", "claude", "run", "--minimal")
	if warm.ExitCode != 0 || warm.count("/sync/bootstrap") != 1 {
		t.Fatalf("second launch: exit=%d bootstraps=%d\n%s", warm.ExitCode, warm.count("/sync/bootstrap"), warm.timeline())
	}
}

// Skipping the redundant pass must not hide a real change: an invalidation that
// arrives after a launch's bootstrap still produces a fresh content exchange.
func TestInvalidationAfterLaunchStillRefreshesContent(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a signed real binary")
	}
	rig := newProfRig(t, true)
	launch := rig.run("fresh scope launch", "claude", "run", "--minimal")
	if launch.ExitCode != 0 {
		t.Fatalf("launch failed: %s", launch.Stdout)
	}
	release := rig.standingLeases(1)
	defer release()
	time.Sleep(2500 * time.Millisecond) // let the standing lease's initial passes settle
	before := rig.frames("/sync/bootstrap")
	rig.api.push(frame{Type: "invalidate"})
	deadline := time.Now().Add(10 * time.Second)
	for rig.frames("/sync/bootstrap") <= before {
		if time.Now().After(deadline) {
			t.Fatalf("invalidation produced no content exchange (bootstraps stayed at %d)", before)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// A reconnect is not a first connection: events may have been missed while the
// control connection was down, so the content must be read again.
func TestReconnectAfterLaunchStillRefreshesContent(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a signed real binary")
	}
	rig := newProfRig(t, true)
	launch := rig.run("fresh scope launch", "claude", "run", "--minimal")
	if launch.ExitCode != 0 {
		t.Fatalf("launch failed: %s", launch.Stdout)
	}
	release := rig.standingLeases(1)
	defer release()
	time.Sleep(2500 * time.Millisecond)
	before := rig.frames("/sync/bootstrap")
	rig.api.dropConnections()
	deadline := time.Now().Add(15 * time.Second)
	for rig.frames("/sync/bootstrap") <= before {
		if time.Now().After(deadline) {
			t.Fatalf("reconnect produced no content exchange (bootstraps stayed at %d)", before)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// A server push that arrives while the cold launch's bootstrap is still in flight
// is newer than the state that bootstrap is reading, so the scheduler's pass for
// the scope must still run after it.
func TestPushDuringColdBootstrapStillRefreshesContent(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a signed real binary")
	}
	rig := newProfRig(t, true)
	rig.api.configure(func(a *profAPI) {
		a.byPath = map[string]time.Duration{"/sync/bootstrap": 1200 * time.Millisecond}
		a.connect = 200 * time.Millisecond
	})
	done := make(chan profRun, 1)
	go func() { done <- rig.run("cold launch with a push mid-bootstrap", "claude", "run", "--minimal") }()
	deadline := time.Now().Add(15 * time.Second)
	for rig.api.arrivals("/sync/bootstrap") == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the cold launch never reached /sync/bootstrap")
		}
		time.Sleep(5 * time.Millisecond)
	}
	rig.api.push(frame{Type: "invalidate"})
	launch := <-done
	if launch.ExitCode != 0 {
		t.Fatalf("launch failed: %s", launch.Stdout)
	}
	for rig.frames("/sync/bootstrap") < 2 {
		if time.Now().After(deadline.Add(15 * time.Second)) {
			t.Fatalf("a push during the cold bootstrap produced no second exchange (bootstraps: %d)\n%s", rig.frames("/sync/bootstrap"), launch.timeline())
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// A primed owner serves the next launch from its warm cache: the launch's only
// bootstrap is auth-only (include_content:false) and no content worker runs in
// front of it. A fresh owner still performs the full first exchange.
func TestPrimedOwnerLaunchSkipsContentExchange(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a signed real binary")
	}
	rig := newProfRig(t, true, func(cfg *config.Config) { cfg.Orchestrator.CommunicatorCacheProtocol = CacheProtocol })
	cold := rig.run("fresh owner launch", "claude", "run", "--minimal")
	if cold.ExitCode != 0 || cold.count("/sync/bootstrap") != 1 {
		t.Fatalf("cold launch: exit=%d bootstraps=%d\n%s", cold.ExitCode, cold.count("/sync/bootstrap"), cold.timeline())
	}
	rig.api.mu.Lock()
	if rig.api.contentless != 0 {
		rig.api.mu.Unlock()
		t.Fatal("a fresh owner must perform the full content exchange first")
	}
	rig.api.mu.Unlock()
	warm := rig.run("primed launch", "claude", "run", "--minimal")
	if warm.ExitCode != 0 {
		t.Fatalf("warm launch failed: %s", warm.Stdout)
	}
	rig.api.mu.Lock()
	contentless := rig.api.contentless
	rig.api.mu.Unlock()
	if warm.count("/sync/bootstrap") != 1 || contentless != 1 {
		t.Fatalf("primed launch: bootstraps=%d contentless=%d\n%s", warm.count("/sync/bootstrap"), contentless, warm.timeline())
	}
}

// A primed scope is current only until the next server invalidation, and an
// explicit sync never trusts it. Invalidations re-run content only for scopes
// with a live lease, so after a reconnect (an API deploy) with no session
// attached, the next launch must perform the full exchange again.
func TestPrimedScopeYieldsToExplicitSyncAndReconnect(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a signed real binary")
	}
	rig := newProfRig(t, true, func(cfg *config.Config) { cfg.Orchestrator.CommunicatorCacheProtocol = CacheProtocol })
	contentless := func() int {
		rig.api.mu.Lock()
		defer rig.api.mu.Unlock()
		return rig.api.contentless
	}
	if cold := rig.run("fresh owner launch", "claude", "run", "--minimal"); cold.ExitCode != 0 {
		t.Fatalf("cold launch failed: %s", cold.Stdout)
	}
	if warm := rig.run("primed launch", "claude", "run", "--minimal"); warm.ExitCode != 0 || contentless() != 1 {
		t.Fatalf("primed launch: exit=%d contentless=%d\n%s", warm.ExitCode, contentless(), warm.timeline())
	}
	explicit := rig.run("explicit sync", "claude", "sync")
	if explicit.ExitCode != 0 {
		t.Fatalf("explicit sync failed: %s", explicit.Stdout)
	}
	if explicit.count("/sync/bootstrap") < 1 || contentless() != 1 {
		t.Fatalf("an explicit sync must perform a full content exchange: bootstraps=%d contentless=%d\n%s", explicit.count("/sync/bootstrap"), contentless(), explicit.timeline())
	}
	// A server deploy drops the control connection; nothing is attached to the
	// scope, so no scheduled pass refreshes it.
	rig.api.dropConnections()
	deadline := time.Now().Add(15 * time.Second)
	for {
		rig.api.mu.Lock()
		reconnected := len(rig.api.conns) > 0
		rig.api.mu.Unlock()
		if reconnected {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the owner never reconnected")
		}
		time.Sleep(25 * time.Millisecond)
	}
	time.Sleep(time.Second) // the reconnect invalidation is stamped after the handshake
	after := rig.run("launch after reconnect", "claude", "run", "--minimal")
	if after.ExitCode != 0 || after.count("/sync/bootstrap") != 1 || contentless() != 1 {
		t.Fatalf("a launch after an unserved invalidation must not trust the primed scope: exit=%d bootstraps=%d contentless=%d\n%s", after.ExitCode, after.count("/sync/bootstrap"), contentless(), after.timeline())
	}
	// That full exchange primes the scope again.
	if again := rig.run("re-primed launch", "claude", "run", "--minimal"); again.ExitCode != 0 || contentless() != 2 {
		t.Fatalf("re-primed launch: exit=%d contentless=%d\n%s", again.ExitCode, contentless(), again.timeline())
	}
}
