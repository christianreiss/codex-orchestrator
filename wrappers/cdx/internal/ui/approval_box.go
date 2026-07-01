// Package ui — approval_box.go renders the insecure-host approval polling box.
//
// Legacy bash drew one framed status box, then re-rendered it in place on a
// 5-second tick (`\033[2K\r` plus cursor save/restore). Operators see one
// box with `last check` + `checks` counter that ticks until the status
// flips away from `insecure`, or until ctx.Done.
package ui

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// AuthChecker is the minimal slice of orchestrator.Client this UI needs. It
// returns the lower-cased auth status and a free-form reason string ("" if
// none). The orchestrator package defines a concrete type that satisfies
// this; we keep it as an interface so this file has no orchestrator import.
type AuthChecker interface {
	CheckAuthStatus(ctx context.Context) (status string, reason string, err error)
}

// PollApproval renders the framed status box and re-paints in place every
// `refresh`. Returns (true, nil) when the status flips away from `insecure`
// (i.e. operator clicked Enable), (false, ctx.Err()) on cancellation, or
// (false, err) on permanent network failure that the caller should surface.
//
// The first repaint draws full lines; subsequent repaints emit a CSI cursor
// save, walk the cursor up by the box height, clear each line, then restore
// the cursor — so the box appears to stay in place.
func PollApproval(ctx context.Context, client AuthChecker, refresh time.Duration) (bool, error) {
	if refresh <= 0 {
		refresh = 5 * time.Second
	}
	caps := DetectCaps("")
	out := io.Writer(os.Stderr)

	start := time.Now()
	checks := 0
	lastStatus := "insecure"
	lastReason := ""
	const boxLines = 6

	draw := func(first bool) {
		if !first {
			// Move cursor up boxLines lines and erase each.
			for i := 0; i < boxLines; i++ {
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
				// Surface the error inside the box without exiting; the
				// operator can ctrl-c.
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

type approvalBoxData struct {
	StartedAt time.Time
	LastCheck time.Time
	Checks    int
	Status    string
	Reason    string
}

// drawApprovalBox renders the framed insecure-approval status box. Width is
// clamped to the available terminal columns (min 50).
func drawApprovalBox(w io.Writer, caps Caps, d approvalBoxData) {
	width := caps.Columns - 2
	if width < 50 {
		width = 50
	}
	if width > 100 {
		width = 100
	}
	g := caps.BannerSym

	title := "Awaiting insecure-host approval"
	body := "Open the admin dashboard and click Enable window for this host."
	last := "last check  " + d.LastCheck.Format("15:04:05")
	count := fmt.Sprintf("checks      %d  (elapsed %s)", d.Checks, durationShort(time.Since(d.StartedAt)))
	status := "status      " + d.Status
	if d.Reason != "" {
		status += "  -  " + d.Reason
	}

	inner := width - 2
	top := caps.Palette.Dim + g.BoxTL + strings.Repeat(g.BoxH, inner) + g.BoxTR + caps.Palette.Reset
	bot := caps.Palette.Dim + g.BoxBL + strings.Repeat(g.BoxH, inner) + g.BoxBR + caps.Palette.Reset
	line := func(s string) string {
		padded := PadRight(s, inner-2)
		return caps.Palette.Dim + g.BoxV + caps.Palette.Reset + " " + padded + " " + caps.Palette.Dim + g.BoxV + caps.Palette.Reset
	}
	fmt.Fprintln(w, top)
	fmt.Fprintln(w, line(caps.Palette.Bold+title+caps.Palette.Reset))
	fmt.Fprintln(w, line(body))
	fmt.Fprintln(w, line(truncateVisible(status, inner-2)))
	fmt.Fprintln(w, line(last+"   "+count))
	fmt.Fprintln(w, bot)
}

// truncateVisible clamps s to at most width visible columns, replacing any
// overflow with a trailing ellipsis. Server-supplied text (status/reason)
// has no upper bound, and PadRight never shortens an over-long string, so
// without this the box would wrap onto extra terminal lines and corrupt
// PollApproval's fixed-height redraw.
func truncateVisible(s string, width int) string {
	if width <= 0 {
		return ""
	}
	if VisibleWidth(s) <= width {
		return s
	}
	r := []rune(s)
	if width <= 3 {
		if len(r) > width {
			r = r[:width]
		}
		return string(r)
	}
	w := 0
	i := 0
	for i < len(r) {
		cw := 1
		if isWide(r[i]) {
			cw = 2
		}
		if w+cw > width-3 {
			break
		}
		w += cw
		i++
	}
	return string(r[:i]) + "..."
}

func durationShort(d time.Duration) string {
	d = d.Round(time.Second)
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
}
