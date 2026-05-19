// Package ui — approval_box.go renders the insecure-host approval polling
// box for clx. 1:1 mirror of the cdx implementation.
package ui

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// AuthChecker is the minimal slice of orchestrator.Client this UI needs.
type AuthChecker interface {
	CheckAuthStatus(ctx context.Context) (status string, reason string, err error)
}

// PollApproval renders the framed status box and re-paints in place every
// `refresh`. Returns (true, nil) on status flip away from `insecure`,
// (false, ctx.Err()) on cancellation.
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
	fmt.Fprintln(w, line(status))
	fmt.Fprintln(w, line(last+"   "+count))
	fmt.Fprintln(w, bot)
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
