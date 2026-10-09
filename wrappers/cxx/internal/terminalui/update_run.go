package terminalui

import (
	"fmt"
	"github.com/charmbracelet/x/ansi"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
)

// UpdateRow animates one bounded physical row, then leaves one final receipt.
// Only this renderer writes while a row is active; worker events update state.
type UpdateRow struct {
	mu             sync.Mutex
	w              io.Writer
	caps           Caps
	label, version string
	event          updateprogress.Event
	frame          int
	live, closed   bool
	stop, done     chan struct{}
}

func StartUpdateRow(w io.Writer, caps Caps, label, version string) *UpdateRow {
	if caps.Columns <= 0 {
		caps.Columns = 80
	}
	if !caps.IsTTY || caps.Dumb {
		caps = MinimalCaps(caps)
	}
	r := &UpdateRow{w: w, caps: engineCaps(caps, label), label: label, version: version,
		event: updateprogress.Event{Phase: "checking"}, stop: make(chan struct{}), done: make(chan struct{})}
	r.live = caps.IsTTY && !caps.Dumb && caps.Columns >= 32
	if !r.live {
		close(r.done)
		return r
	}
	_, _ = io.WriteString(w, "\x1b[?25l")
	r.draw()
	go func() {
		defer close(r.done)
		ticker := time.NewTicker(90 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-r.stop:
				return
			case <-ticker.C:
				r.mu.Lock()
				r.frame++
				r.draw()
				r.mu.Unlock()
			}
		}
	}()
	return r
}

func (r *UpdateRow) Observe(event updateprogress.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.closed {
		r.event = event
	}
}

func (r *UpdateRow) SetVersion(version string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.version = version
}

func (r *UpdateRow) draw() {
	frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	if !r.caps.UTF8 {
		frames = []string{"|", "/", "-", "\\"}
	}
	status := r.event.Phase
	if status == "downloading" && r.event.Total > 0 {
		percent := min(100, int(100*float64(r.event.Bytes)/float64(r.event.Total)))
		width := 16
		if r.caps.Columns < 75 {
			width = 8
		}
		if r.caps.Columns < 48 {
			width = 4
		}
		fill, empty := "━", "─"
		if !r.caps.UTF8 {
			fill, empty = "=", "-"
		}
		filled := width * percent / 100
		status = fmt.Sprintf("%3d%% %s%s %s/%s", percent, strings.Repeat(fill, filled), strings.Repeat(empty, width-filled), updateBytes(r.event.Bytes), updateBytes(r.event.Total))
	} else if status == "downloading" && r.event.Bytes > 0 {
		status += " " + updateBytes(r.event.Bytes)
	}
	line := r.line(frames[r.frame%len(frames)], status)
	_, _ = io.WriteString(r.w, progressClearLine+line)
}

func (r *UpdateRow) line(glyph, status string) string {
	if !r.caps.IsTTY {
		return fmt.Sprintf("%s %-7s %-23s %s", glyph, PlainInline(r.label), PlainInline(r.version), PlainInline(status))
	}
	versionWidth := 23
	if r.caps.Columns < 75 {
		versionWidth = max(9, r.caps.Columns-47)
	}
	tail := "…"
	if !r.caps.UTF8 {
		tail = "..."
	}
	version := ansi.Truncate(inlineFor(r.caps, r.version), versionWidth, tail)
	line := fmt.Sprintf("%s %-7s %-*s %s", glyph, inlineFor(r.caps, r.label), versionWidth, version, inlineFor(r.caps, status))
	line = ansi.Truncate(line, max(1, r.caps.Columns-1), tail)
	return r.caps.BannerColor() + line + r.caps.Palette.Reset
}

func (r *UpdateRow) Finish(tone Tone, version, status string) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	close(r.stop)
	r.mu.Unlock()
	<-r.done
	r.mu.Lock()
	defer r.mu.Unlock()
	r.version = version
	glyph := "✓"
	if tone == ToneWarn {
		glyph = "▲"
	} else if tone == ToneFail {
		glyph = "✗"
	}
	if !r.caps.UTF8 || r.caps.Dumb {
		glyph = map[Tone]string{ToneOK: "OK", ToneWarn: "WARN", ToneFail: "FAIL"}[tone]
	}
	if r.live {
		_, _ = io.WriteString(r.w, progressClearLine+"\x1b[?25h")
	}
	fmt.Fprintln(r.w, r.line(glyph, status))
}

func updateBytes(n int64) string {
	if n < 1<<20 {
		return fmt.Sprintf("%.0fK", float64(n)/1024)
	}
	return fmt.Sprintf("%.1fM", float64(n)/(1<<20))
}
