package terminalui

import (
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
)

// UpdateRun is the sole writer for a fixed block of concurrently updated rows.
// Worker methods only change state; one ticker paints the complete block.
type UpdateRun struct {
	mu         sync.Mutex
	w          io.Writer
	rows       []*UpdateRow
	live       bool
	stop, done chan struct{}
	once       sync.Once
}

func StartUpdateRun(w io.Writer, caps Caps, labels []string) *UpdateRun {
	if caps.Columns <= 0 {
		caps.Columns = 80
	}
	if !caps.IsTTY || caps.Dumb || caps.Columns < 32 {
		caps = MinimalCaps(caps)
	}
	u := &UpdateRun{w: w, live: caps.IsTTY && !caps.Dumb && caps.Columns >= 32 && len(labels) > 0, stop: make(chan struct{}), done: make(chan struct{})}
	for _, label := range labels {
		u.rows = append(u.rows, &UpdateRow{w: w, caps: engineCaps(caps, label), label: label, event: updateprogress.Event{Phase: "checking"}, run: u})
	}
	if !u.live {
		close(u.done)
		return u
	}
	_, _ = io.WriteString(w, "\x1b[?25l")
	u.draw(false)
	go func() {
		defer close(u.done)
		ticker := time.NewTicker(90 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-u.stop:
				return
			case <-ticker.C:
				u.draw(true)
			}
		}
	}()
	return u
}

func (u *UpdateRun) Row(i int) *UpdateRow { return u.rows[i] }

func (u *UpdateRun) draw(replace bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if replace {
		fmt.Fprintf(u.w, "\x1b[%dA", len(u.rows))
	}
	for _, row := range u.rows {
		row.mu.Lock()
		row.frame++
		line := row.content()
		row.mu.Unlock()
		fmt.Fprintln(u.w, progressClearLine+line)
	}
}

// Close leaves one settled block, restoring the cursor exactly once. Call only
// after workers have joined, before any ordinary output resumes.
func (u *UpdateRun) Close() {
	u.once.Do(func() {
		close(u.stop)
		<-u.done
		for _, row := range u.rows {
			row.mu.Lock()
			if !row.closed {
				row.closed, row.tone, row.status = true, ToneFail, "interrupted"
			}
			row.mu.Unlock()
		}
		if u.live {
			u.draw(true)
			_, _ = io.WriteString(u.w, "\x1b[?25h")
		} else {
			for _, row := range u.rows {
				row.mu.Lock()
				fmt.Fprintln(u.w, row.content())
				row.mu.Unlock()
			}
		}
	})
}
