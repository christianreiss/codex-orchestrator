package enginedestroy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
)

// Report tells the orchestrator how a destroy request is going. status is
// "running", "done" or "failed"; residue lists what could not be removed.
func Report(ctx context.Context, cfg *config.Config, engine, requestID, status string, residue []string) error {
	if residue == nil {
		residue = []string{}
	}
	raw, err := json.Marshal(map[string]any{"engine": engine, "request_id": requestID, "status": status, "residue": residue})
	if err != nil {
		return err
	}
	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, "POST", strings.TrimRight(cfg.Orchestrator.BaseURL, "/")+"/host/engine-destroy/report", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
	communicator.SetAPIHeader(req.Header)
	req.Header.Set("Content-Type", "application/json")
	client, err := update.HTTPClient(cfg)
	if err != nil {
		return err
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("engine-destroy report unavailable: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("engine-destroy report: HTTP %d", resp.StatusCode)
	}
	return nil
}
