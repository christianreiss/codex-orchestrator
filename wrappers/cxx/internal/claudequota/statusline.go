// Package claudequota implements `cxx claude-quota-statusline`, the
// fleet-owned Claude Code statusLine command (wired in via
// client-config.ts's renderClaudeSettingsPartialForHost, gated on the host's
// own self-reported wrapper version so an older `cxx` is never handed a
// statusLine command it does not understand yet).
//
// Claude Code invokes this command as a subprocess on every statusline
// render and feeds a JSON payload on stdin; as of Claude Code >= 2.1.80 that
// payload includes a `rate_limits` object carrying the account's own
// already-computed Pro/Max quota for the 5-hour and 7-day windows (see
// anthropics/claude-code#20636 and its CHANGELOG entry). The exact field
// name for the percentage — `utilization`, scaled 0-100 — was confirmed by
// reading it out of the installed @anthropic-ai/claude-code 2.1.235 binary
// (see rawWindow's doc comment); everything else about the shape is still an
// inference and parsed defensively. This package has two jobs: print a
// usable statusline, and — throttled — report those percentages to the
// orchestrator so the dashboard's Claude usage card has a live number.
//
// This is deliberately the ONLY way this fleet obtains Claude usage/quota
// data. The orchestrator server never holds or calls out with a Claude OAuth
// token: Anthropic's Consumer ToS prohibits third-party use of a
// Free/Pro/Max subscription's OAuth token, with public enforcement
// precedent against tools that did. Claude Code itself is the sanctioned
// client computing this number; this command only relays what it already
// said.
package claudequota

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

// minReportInterval bounds how often this fires the network call, independent
// of how often Claude Code refreshes the statusline (which can be as often as
// every render). A changed percentage always reports immediately regardless
// of this floor. Matches ChatGptUsageService's MIN_REFRESH_SECONDS (300s):
// that service is one server-side poller, this is one call per host, so
// matching its order of magnitude is what keeps steady-state row volume
// comparable instead of a per-render insert flood.
const minReportInterval = 5 * time.Minute

// Small and deliberately so: this runs inside Claude Code's statusline
// render, and this fleet has no confirmed number for how long Claude Code
// lets that command run before it gives up. A short, bounded worst case
// under any plausible budget beats guessing at "comfortably under" a number
// nobody here has measured.
const networkTimeout = 800 * time.Millisecond

// reportWindow is one resolved rate-limit window ready to render or report.
type reportWindow struct {
	UsedPercent float64
	ResetsAt    string
}

// rawWindow's field order is confidence order, highest first. `Utilization`
// is the name actually shipped: read out of the installed
// @anthropic-ai/claude-code 2.1.235 binary (bin/claude.exe) via `strings`,
// its internal rate-limit projector reads `r.utilization` and does
// `r.utilization*100` to produce the exposed percentage — not
// `used_percentage`, which was this package's original guess sourced from
// secondhand community-tool inference (a GitHub changelog's prose, not the
// real field). `used_percentage`/`used_percent` stay as fallbacks in case a
// different code path or a future version exposes an alternate shape; they
// cost nothing and only fire when `utilization` is absent. `resets_at` is
// confirmed correct as-is: the same binary converts an internal Unix-seconds
// epoch to an ISO 8601 string before exposing it externally.
type rawWindow struct {
	Utilization    *float64 `json:"utilization"`
	UsedPercentage *float64 `json:"used_percentage"`
	UsedPercent    *float64 `json:"used_percent"`
	ResetsAt       string   `json:"resets_at"`
	ResetAt        string   `json:"reset_at"`
}

func (w *rawWindow) resolve() *reportWindow {
	if w == nil {
		return nil
	}
	pct := w.Utilization
	if pct == nil {
		pct = w.UsedPercentage
	}
	if pct == nil {
		pct = w.UsedPercent
	}
	if pct == nil {
		return nil
	}
	resetsAt := w.ResetsAt
	if resetsAt == "" {
		resetsAt = w.ResetAt
	}
	return &reportWindow{UsedPercent: *pct, ResetsAt: resetsAt}
}

// statusPayload is the subset of Claude Code's statusline stdin JSON this
// command reads. Unknown fields are ignored; a payload from an older Claude
// Code version (no rate_limits) or a malformed one both decode to a mostly
// zero-value payload rather than an error — the statusline must never fail.
type statusPayload struct {
	Model struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
	} `json:"model"`
	Workspace struct {
		CurrentDir string `json:"current_dir"`
	} `json:"workspace"`
	Cwd        string `json:"cwd"`
	RateLimits *struct {
		FiveHour *rawWindow `json:"five_hour"`
		SevenDay *rawWindow `json:"seven_day"`
	} `json:"rate_limits"`
}

func parsePayload(raw []byte) statusPayload {
	var p statusPayload
	_ = json.Unmarshal(raw, &p)
	return p
}

func extractRateLimits(p statusPayload) (fiveHour, sevenDay *reportWindow) {
	if p.RateLimits == nil {
		return nil, nil
	}
	return p.RateLimits.FiveHour.resolve(), p.RateLimits.SevenDay.resolve()
}

// renderStatusLine never returns an empty string: Claude Code renders
// whatever this prints verbatim, and a blank status bar reads as broken.
func renderStatusLine(p statusPayload, fiveHour, sevenDay *reportWindow) string {
	var segments []string

	model := strings.TrimSpace(p.Model.DisplayName)
	if model == "" {
		model = strings.TrimSpace(p.Model.ID)
	}
	if model != "" {
		segments = append(segments, model)
	}

	dir := strings.TrimSpace(p.Workspace.CurrentDir)
	if dir == "" {
		dir = strings.TrimSpace(p.Cwd)
	}
	if dir != "" {
		segments = append(segments, filepath.Base(dir))
	}

	if quota := formatQuotaSegment(fiveHour, sevenDay); quota != "" {
		segments = append(segments, quota)
	}

	if len(segments) == 0 {
		return "clx"
	}
	return strings.Join(segments, " · ")
}

func formatQuotaSegment(fiveHour, sevenDay *reportWindow) string {
	var parts []string
	if fiveHour != nil {
		parts = append(parts, fmt.Sprintf("5h %d%%", roundPercent(fiveHour.UsedPercent)))
	}
	if sevenDay != nil {
		parts = append(parts, fmt.Sprintf("7d %d%%", roundPercent(sevenDay.UsedPercent)))
	}
	return strings.Join(parts, " ")
}

func roundPercent(v float64) int {
	return int(math.Round(v))
}

// reportState is the small on-disk throttle record at
// ~/.clx/state/claude-quota-report.json.
type reportState struct {
	ReportedAt      string `json:"reported_at"`
	FiveHourPercent *int   `json:"five_hour_percent,omitempty"`
	SevenDayPercent *int   `json:"seven_day_percent,omitempty"`
}

// shouldReport fires on a changed rounded percentage (immediately) or once
// minReportInterval has elapsed since the last successful report (a
// heartbeat, so `fetched_at` on an unchanged reading still advances).
func shouldReport(prev *reportState, fiveHour, sevenDay *reportWindow, now time.Time) bool {
	if prev == nil {
		return true
	}
	if percentChanged(prev.FiveHourPercent, fiveHour) || percentChanged(prev.SevenDayPercent, sevenDay) {
		return true
	}
	reportedAt, err := time.Parse(time.RFC3339, prev.ReportedAt)
	return err != nil || now.Sub(reportedAt) >= minReportInterval
}

func percentChanged(prev *int, w *reportWindow) bool {
	if w == nil {
		return false
	}
	rounded := roundPercent(w.UsedPercent)
	return prev == nil || *prev != rounded
}

func newState(fiveHour, sevenDay *reportWindow, now time.Time) reportState {
	st := reportState{ReportedAt: now.UTC().Format(time.RFC3339)}
	if fiveHour != nil {
		v := roundPercent(fiveHour.UsedPercent)
		st.FiveHourPercent = &v
	}
	if sevenDay != nil {
		v := roundPercent(sevenDay.UsedPercent)
		st.SevenDayPercent = &v
	}
	return st
}

func stateFilePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".clx", "state", "claude-quota-report.json"), nil
}

func readState(path string) *reportState {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var st reportState
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil
	}
	return &st
}

func writeState(path string, st reportState) {
	raw, err := json.Marshal(st)
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	_ = os.WriteFile(path, raw, 0o600)
}

func reportBody(fiveHour, sevenDay *reportWindow) map[string]any {
	body := map[string]any{"source": "statusline"}
	if fiveHour != nil {
		body["five_hour"] = map[string]any{"used_percent": fiveHour.UsedPercent, "resets_at": fiveHour.ResetsAt}
	}
	if sevenDay != nil {
		body["seven_day"] = map[string]any{"used_percent": sevenDay.UsedPercent, "resets_at": sevenDay.ResetsAt}
	}
	return body
}

// attemptReport builds a client from on-disk config and posts the report.
// Any failure (no config yet, unreachable orchestrator, ...) is swallowed:
// the next statusline render tries again, and the statusline itself must
// never fail or print an error on account of the network.
func attemptReport(fiveHour, sevenDay *reportWindow) bool {
	path, err := config.DefaultPathForEngine(config.EngineClaude)
	if err != nil {
		return false
	}
	pubkey, _ := signing.PublicKey()
	cfg, err := config.LoadForEngine(path, pubkey, false, config.EngineClaude)
	if err != nil {
		return false
	}
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
		Timeout:       networkTimeout,
	})
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), networkTimeout)
	defer cancel()
	err = client.JSON(ctx, http.MethodPost, "/claude/usage/report", reportBody(fiveHour, sevenDay), nil, 0)
	return err == nil
}

// RunCommand implements `cxx claude-quota-statusline`. Always exits 0 and
// always prints exactly one statusline: reporting is a throttled side
// effect, never something the caller waits on or that can fail the render.
func RunCommand(stdin io.Reader, stdout, _ io.Writer) int {
	raw, _ := io.ReadAll(io.LimitReader(stdin, 1<<20))
	payload := parsePayload(raw)
	fiveHour, sevenDay := extractRateLimits(payload)

	fmt.Fprintln(stdout, renderStatusLine(payload, fiveHour, sevenDay))

	if fiveHour == nil && sevenDay == nil {
		return 0
	}

	statePath, err := stateFilePath()
	if err != nil {
		return 0
	}
	now := time.Now().UTC()
	if !shouldReport(readState(statePath), fiveHour, sevenDay, now) {
		return 0
	}
	if attemptReport(fiveHour, sevenDay) {
		writeState(statePath, newState(fiveHour, sevenDay, now))
	}
	return 0
}
