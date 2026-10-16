package housekeeping

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionguard"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type remoteServer struct{ cfg *config.Config }

func (s remoteServer) call(ctx context.Context, action, token string, report *Result) (Protection, error) {
	raw, err := json.Marshal(map[string]any{"engine": s.cfg.Engine, "token": token, "report": report})
	if err != nil {
		return Protection{}, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, "POST", strings.TrimRight(s.cfg.Orchestrator.BaseURL, "/")+"/host/session-housekeeping/"+action, bytes.NewReader(raw))
	if err != nil {
		return Protection{}, err
	}
	req.Header.Set("X-API-Key", s.cfg.Orchestrator.APIKey)
	req.Header.Set("Content-Type", "application/json")
	client, err := update.HTTPClient(s.cfg)
	if err != nil {
		return Protection{}, err
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return Protection{}, fmt.Errorf("housekeeping %s unavailable", action)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return Protection{}, fmt.Errorf("housekeeping %s: %s", action, refusal(resp))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return Protection{}, err
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err = json.Unmarshal(body, &envelope); err != nil {
		return Protection{}, err
	}
	if envelope.Data != nil {
		body = envelope.Data
	}
	var p Protection
	err = json.Unmarshal(body, &p)
	return p, err
}

// refusal names why the server refused a call: its status plus the error
// code, message and (for ip_mismatch) the refused request's address family,
// so a binding denial is not reported as a bare "HTTP 401".
func refusal(resp *http.Response) string {
	out := fmt.Sprintf("HTTP %d", resp.StatusCode)
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	var body struct {
		Code     string `json:"code"`
		Message  string `json:"message"`
		IPFamily string `json:"ip_family"`
	}
	if json.Unmarshal(raw, &body) != nil || body.Code == "" {
		return out
	}
	out += " " + body.Code
	detail := []string{}
	if body.Message != "" {
		detail = append(detail, body.Message)
	}
	if body.IPFamily != "" {
		detail = append(detail, "refused over "+body.IPFamily)
	}
	if len(detail) > 0 {
		out += " (" + strings.Join(detail, "; ") + ")"
	}
	return out
}

func (s remoteServer) Inspect(ctx context.Context) (Protection, error) {
	return s.call(ctx, "inspect", "", nil)
}
func (s remoteServer) Reserve(ctx context.Context, token string) (Protection, error) {
	return s.call(ctx, "reserve", token, nil)
}
func (s remoteServer) Release(ctx context.Context, token string) error {
	_, err := s.call(ctx, "release", token, nil)
	return err
}
func (s remoteServer) Report(ctx context.Context, r Result) error {
	_, err := s.call(ctx, "report", "", &r)
	return err
}
func Automatic(ctx context.Context, cfg *config.Config, w io.Writer) error {
	if cfg == nil || cfg.SessionHousekeeping == nil || !cfg.SessionHousekeeping.Enabled || cfg.EngineSuspended(cfg.Engine) {
		return nil
	}
	root, err := sessionguard.Root(cfg.Engine)
	if err != nil {
		return err
	}
	r, err := Run(ctx, Options{Root: root, Engine: cfg.Engine, Automatic: true, Server: remoteServer{cfg}})
	if r.Outcome != "not_due" && r.Outcome != "absent" {
		render(w, r)
	}
	return err
}
func render(w io.Writer, r Result) {
	if r.Outcome == "skipped" && r.BytesBefore == 0 {
		if r.Detail != "" {
			fmt.Fprintf(w, "housekeeping %s: skipped (%s: %s; inventory deferred)\n", r.Engine, r.Reason, r.Detail)
			return
		}
		fmt.Fprintf(w, "housekeeping %s: skipped (%s; inventory deferred)\n", r.Engine, r.Reason)
		return
	}
	fmt.Fprintf(w, "housekeeping %s: %s; %.2f → %.2f GiB, %d candidates, %d protected, %d removed", r.Engine, r.Outcome, float64(r.BytesBefore)/(1<<30), float64(r.BytesAfter)/(1<<30), r.Candidates, r.Protected, r.Deleted)
	if r.Reason != "" {
		fmt.Fprintf(w, " (%s)", r.Reason)
	}
	fmt.Fprintln(w)
}
func Command(args []string, selected string, stdout, stderr io.Writer) int {
	action := "status"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		action = args[0]
		args = args[1:]
	}
	engine := selected
	jsonOut, dry := false, false
	id := ""
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--engine":
			i++
			if i >= len(args) {
				fmt.Fprintln(stderr, "--engine needs codex, claude or grok")
				return 2
			}
			engine = args[i]
		case "--json":
			jsonOut = true
		case "--dry-run":
			dry = true
		default:
			if id != "" || strings.HasPrefix(args[i], "-") {
				fmt.Fprintln(stderr, "unknown housekeeping argument")
				return 2
			}
			id = args[i]
		}
	}
	if action != "run" && action != "status" && action != "pin" && action != "unpin" {
		fmt.Fprintln(stderr, "usage: cxx housekeeping status|run [--dry-run] [--engine ENGINE] [--json] | pin|unpin UUID --engine ENGINE")
		return 2
	}
	if engine != "" && engine != "codex" && engine != "claude" && engine != "grok" {
		fmt.Fprintln(stderr, "unknown housekeeping engine")
		return 2
	}
	if action == "pin" || action == "unpin" {
		if engine == "" || id == "" {
			fmt.Fprintln(stderr, "pin/unpin require a session UUID and engine")
			return 2
		}
		root, err := sessionguard.Root(engine)
		if err == nil {
			err = Pin(root, id, action == "pin")
		}
		if err != nil {
			fmt.Fprintln(stderr, "housekeeping:", err)
			return 1
		}
		fmt.Fprintln(stdout, "housekeeping pin updated")
		return 0
	}
	if id != "" {
		fmt.Fprintln(stderr, "session id is only accepted for pin/unpin")
		return 2
	}
	engines := []string{engine}
	if engine == "" {
		engines = []string{"codex", "claude", "grok"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	key, err := signing.PublicKey()
	if err != nil {
		fmt.Fprintln(stderr, "housekeeping:", err)
		return 1
	}
	var results []Result
	code := 0
	for _, e := range engines {
		path, err := config.DefaultPathForEngine(e)
		if err != nil {
			fmt.Fprintln(stderr, err)
			code = 1
			continue
		}
		cfg, _, err := fleetconfig.LoadOrRecover(ctx, path, key, e)
		if errors.Is(err, os.ErrNotExist) && engine == "" {
			continue
		}
		if err != nil {
			fmt.Fprintln(stderr, "housekeeping", e, ":", err)
			code = 1
			continue
		}
		if cfg.EngineSuspended(e) {
			results = append(results, Result{Engine: e, Outcome: "suspended"})
			continue
		}
		root, err := sessionguard.Root(e)
		if err != nil {
			fmt.Fprintln(stderr, err)
			code = 1
			continue
		}
		r, err := Run(ctx, Options{Root: root, Engine: e, DryRun: dry || action == "status", Server: remoteServer{cfg}})
		results = append(results, r)
		if err != nil {
			fmt.Fprintln(stderr, "housekeeping", e, ":", err)
			code = 1
		}
	}
	if jsonOut {
		_ = json.NewEncoder(stdout).Encode(results)
	} else {
		for _, r := range results {
			render(stdout, r)
		}
	}
	return code
}
