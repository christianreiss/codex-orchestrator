// Package ui renders the insecure-host approval polling box.
package terminalui

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/term"
)

const (
	approvalBoxLines       = 6
	minApprovalColumns     = 40
	maxApprovalBoxWidth    = 100
	approvalBoxSidePadding = 2
)

// AuthChecker is the minimal slice of orchestrator.Client this UI needs.
type AuthChecker interface {
	CheckAuthStatus(ctx context.Context) (status string, reason string, err error)
}

// PollApproval renders the framed status box and re-paints in place every
// refresh. Cursor movement is used only when stderr is an interactive,
// non-dumb terminal with a known, usable width.
func PollApproval(ctx context.Context, client AuthChecker, refresh time.Duration, minimal bool) (bool, error) {
	return PollApprovalFor("cdx")(ctx, client, refresh, minimal)
}

// PollApprovalFor binds a persona without sharing mutable theme state between
// the Codex and Claude legs of a host sync.
func PollApprovalFor(prefix string) func(context.Context, AuthChecker, time.Duration, bool) (bool, error) {
	return func(ctx context.Context, client AuthChecker, refresh time.Duration, minimal bool) (bool, error) {
		caps := engineCaps(approvalTerminalCaps(), prefix)
		if usePlainApproval(caps, minimal) {
			return pollApprovalPlain(ctx, client, refresh, caps, os.Stderr)
		}
		return pollApproval(ctx, client, refresh, caps, os.Stderr)
	}
}

func usePlainApproval(caps Caps, minimal bool) bool {
	return minimal || caps.NoColor
}

func pollApprovalPlain(ctx context.Context, client AuthChecker, refresh time.Duration, caps Caps, out io.Writer) (bool, error) {
	if !caps.IsTTY {
		return false, fmt.Errorf("insecure-host approval pending: stderr is not an interactive terminal; open Admin -> Host Detail, enable this host window, then retry")
	}
	if refresh <= 0 {
		refresh = 5 * time.Second
	}
	if out == nil {
		out = io.Discard
	}
	caps = MinimalCaps(caps)
	start := time.Now()
	checks := 0
	printPlainLine(out, caps, "approval | status=pending | Admin: enable this host window")
	tick := time.NewTicker(refresh)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-tick.C:
			checks++
			cctx, cancel := context.WithTimeout(ctx, refresh)
			status, reason, err := client.CheckAuthStatus(cctx)
			cancel()
			if err != nil {
				status, reason = "offline", err.Error()
			}
			line := fmt.Sprintf("approval | status=%s | checks=%d | elapsed=%s", PlainInline(status), checks, durationShort(time.Since(start)))
			if safe := PlainInline(reason); safe != "" {
				line += " | reason=" + safe
			}
			printPlainLine(out, caps, line)
			if err == nil && status != "insecure" {
				return true, nil
			}
		}
	}
}

// approvalTerminalCaps ignores an optimistic COLUMNS override for this
// cursor-moving UI. Repainting a box safely requires the terminal's actual
// width; if it cannot be determined, pollApproval fails before drawing.
func approvalTerminalCaps() Caps {
	caps := DetectCaps("")
	if !caps.IsTTY {
		return caps
	}
	width, _, err := term.GetSize(int(os.Stderr.Fd()))
	if err != nil || width <= 0 {
		caps.Columns = 0
		return caps
	}
	caps.Columns = width
	return caps
}

func pollApproval(ctx context.Context, client AuthChecker, refresh time.Duration, caps Caps, out io.Writer) (bool, error) {
	if err := approvalPollingUnavailable(caps); err != nil {
		return false, err
	}
	if refresh <= 0 {
		refresh = 5 * time.Second
	}
	if out == nil {
		out = io.Discard
	}

	start := time.Now()
	checks := 0
	lastStatus := "insecure"
	lastReason := ""

	draw := func(first bool) {
		if !first {
			for i := 0; i < approvalBoxLines; i++ {
				fmt.Fprint(out, "\033[1A\033[2K")
			}
			fmt.Fprint(out, "\r")
		}
		drawApprovalBox(out, caps, approvalBoxData{
			StartedAt: start,
			LastCheck: time.Now(),
			Checks:    checks,
			Status:    lastStatus,
			Reason:    lastReason,
		})
	}

	draw(true)

	tick := time.NewTicker(refresh)
	defer tick.Stop()

	for {
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-tick.C:
			checks++
			cctx, cancel := context.WithTimeout(ctx, refresh)
			status, reason, err := client.CheckAuthStatus(cctx)
			cancel()
			if err != nil {
				lastStatus = "offline"
				lastReason = err.Error()
				draw(false)
				continue
			}
			lastStatus = status
			lastReason = reason
			draw(false)
			if status != "insecure" {
				return true, nil
			}
		}
	}
}

func approvalPollingUnavailable(caps Caps) error {
	reason := ""
	switch {
	case !caps.IsTTY:
		reason = "stderr is not an interactive terminal"
	case caps.Dumb:
		reason = "TERM is dumb"
	case caps.Columns <= 0:
		reason = "terminal width is unavailable"
	case caps.Columns < minApprovalColumns:
		reason = fmt.Sprintf("terminal is %d columns wide; at least %d are required", caps.Columns, minApprovalColumns)
	default:
		return nil
	}
	return fmt.Errorf("insecure-host approval pending: %s; open Admin -> Host Detail, enable this host window, then retry", reason)
}

type approvalBoxData struct {
	StartedAt time.Time
	LastCheck time.Time
	Checks    int
	Status    string
	Reason    string
}

// drawApprovalBox always stays within caps.Columns. It does not grow a narrow
// terminal to a preferred minimum; PollApproval rejects those terminals before
// this renderer is reached.
func drawApprovalBox(w io.Writer, caps Caps, d approvalBoxData) {
	width := approvalBoxWidth(caps.Columns)
	if w == nil || width == 0 {
		return
	}
	c := newFrame(w, caps)
	c.width, c.inner = width, width-4
	elapsed := d.LastCheck.Sub(d.StartedAt)
	if elapsed < 0 {
		elapsed = 0
	}
	status := CleanInline(d.Status)
	tone := ToneWarn
	if status == "valid" || status == "outdated" {
		tone = ToneOK
	}
	if status == "disabled" || status == "invalid" || status == "insecure-denied" {
		tone = ToneFail
	}
	detail := status
	if d.Reason != "" {
		detail += " - " + CleanInline(d.Reason)
	}
	meta := fmt.Sprintf("%d checks  |  elapsed %s  |  %s", d.Checks, durationShort(elapsed), d.LastCheck.Format("15:04:05"))
	c.top()
	c.line(joinSides(caps.BannerColor()+"HOST APPROVAL"+caps.Palette.Reset, styleTone(caps, tone, strings.ToUpper(toneWord(tone))), c.inner, caps))
	c.line(truncateVisible("Admin: enable this host window.", c.inner))
	c.line(styleTone(caps, tone, truncateVisible(detail, c.inner)))
	c.line(caps.Palette.Dim + truncateVisible(meta, c.inner) + caps.Palette.Reset)
	c.bottom()
}

func approvalBoxWidth(columns int) int {
	width := columns - approvalBoxSidePadding
	if width < 6 {
		return 0
	}
	if width > maxApprovalBoxWidth {
		return maxApprovalBoxWidth
	}
	return width
}

// truncateVisible clamps s to width visible columns. Callers pass sanitized
// text, so truncation cannot split an escape sequence.
func truncateVisible(s string, width int) string {
	if width <= 0 {
		return ""
	}
	if VisibleWidth(s) <= width {
		return s
	}

	limit := width
	suffix := ""
	if width > 3 {
		limit = width - 3
		suffix = "..."
	}
	prefix, _ := splitVisible(s, limit)
	return prefix + suffix
}

func durationShort(d time.Duration) string {
	d = d.Round(time.Second)
	if d < 0 {
		d = 0
	}
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
}
