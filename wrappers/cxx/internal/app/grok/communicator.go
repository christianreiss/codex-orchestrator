package grok

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/contentnotice"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
)

// CommunicatorWork calls only the content writer or the already running private
// runtime's readiness broker. It never logs in, selects an account or refreshes
// a provider token itself.
func CommunicatorWork(ctx context.Context, cfg *config.Config, req communicator.SyncRequest) communicator.SyncResult {
	out := communicator.SyncResult{Resources: map[string]communicator.ResourceResult{}}
	if req.Operation == "auth" {
		if req.Job.Broker == "" {
			out.Error = &communicator.SyncError{Message: "private Grok broker missing"}
			return out
		}
		transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", req.Job.Broker)
		}}
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport, Timeout: 7 * time.Second}
		request, _ := http.NewRequestWithContext(ctx, "POST", "http://grok-auth/readiness", nil)
		res, err := client.Do(request)
		if err != nil {
			out.Error = &communicator.SyncError{Message: "Grok readiness broker unavailable"}
			return out
		}
		defer res.Body.Close()
		if json.NewDecoder(io.LimitReader(res.Body, 65536)).Decode(&out) != nil {
			out.Error = &communicator.SyncError{Message: "Invalid Grok readiness result"}
		}
		return out
	}
	client, err := newClient(cfg, false)
	if err == nil {
		before := contentSnapshot()
		result, e := syncMeasuredManagedWith(ctx, cfg, client, true)
		// Running sessions loaded the previous content at startup. A launching
		// session primes itself after this pass, so only its peers are told.
		if home, herr := native.Home(); herr == nil {
			_ = contentnotice.PublishChanges("grok", filepath.Join(home, "AGENTS.md"), before, contentSnapshot())
		}
		err = e
		out.Sessions, _ = json.Marshal(result.Sessions)
		var skillErr error
		if result.Skills.Failed {
			skillErr = errors.New("Grok skills sync incomplete")
		}
		out.Resources["skills"] = communicator.Resource(result.Skills.Checked, result.Skills.Updated, skillErr)
		out.Resources["config"] = communicator.Resource(result.Config.Checked, result.Config.Updated, err)
	}
	if err != nil {
		out.Error = &communicator.SyncError{Message: err.Error()}
	}
	return out
}

// contentSnapshot digests what a content pass may rewrite, per notice kind.
// An unreadable home yields an empty snapshot, which never publishes.
func contentSnapshot() contentnotice.Snapshot {
	home, err := native.Home()
	if err != nil {
		return contentnotice.Snapshot{}
	}
	state, err := native.StateDir()
	if err != nil {
		return contentnotice.Snapshot{}
	}
	return contentnotice.Capture(map[string][]string{
		contentnotice.KindInstructions: {filepath.Join(home, "AGENTS.md")},
		contentnotice.KindSkills:       {filepath.Join(state, "skills.json")},
		contentnotice.KindConfig:       {filepath.Join(home, "config.toml")},
	})
}
