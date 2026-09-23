package terminalui

import (
	"io"
	"strings"
	"sync"
)

// Progress is one in-flight wrapper step in the notice grammar. A rich
// terminal shows the step immediately and overwrites that same line with the
// outcome:
//
//	› cdx sync    syncing with orchestrator
//	✓ cdx sync    synced with orchestrator      (same line, after Done)
//
// Plain destinations (pipes, logs, TERM=dumb, --minimal) print nothing while
// the step runs and exactly one greppable notice when it completes, so a log
// never collects a dangling "in progress" record. Clear removes a live line
// without leaving a record, for steps whose outcome the next screen reports.
//
// The first Done, Fail or Clear settles the step; later calls are no-ops. All
// methods accept a nil receiver so a quiet caller can pass nil around.
type Progress struct {
	mu      sync.Mutex
	w       io.Writer
	caps    Caps
	prefix  string
	topic   string
	live    bool
	settled bool
}

// progressClearLine returns the cursor to column one and erases the line.
const progressClearLine = "\r\x1b[2K"

// StartProgress begins a step on w. On a rich terminal the step line is
// written at once, without a trailing newline, and must be settled before
// anything else is written to w.
func StartProgress(w io.Writer, caps Caps, prefix, topic, message string) *Progress {
	p := &Progress{w: w, caps: caps, prefix: prefix, topic: topic}
	if line, ok := progressLine(caps, prefix, topic, message); ok {
		p.live = true
		_, _ = io.WriteString(w, line)
	}
	return p
}

// progressLine renders the in-flight line, truncated so it occupies exactly one
// physical row; overwriting relies on that. Destinations that cannot hold one
// rich row report false and fall back to the plain completion record.
func progressLine(caps Caps, prefix, topic, message string) (string, bool) {
	if noticePlain(caps) {
		return "", false
	}
	indent := noticeIndent(caps, prefix, topic)
	if indent == 2 {
		return "", false
	}
	width := caps.Columns
	if width <= 0 {
		width = 80
	}
	// Leave one cell for the cursor so a full-width row never auto-wraps.
	body := min(width, maxCardWidth+indent) - indent - 1
	msg := TruncateText(inlineFor(caps, message), body, caps)
	line := strings.TrimSuffix(FormatNotice(caps, Notice{Prefix: prefix, Topic: topic, Tone: ToneDim, Message: msg}), "\n")
	if strings.Contains(line, "\n") {
		return "", false
	}
	return line, true
}

// Done settles the step as successful with message.
func (p *Progress) Done(message string) { p.settle(ToneOK, message) }

// Fail settles the step as failed with message.
func (p *Progress) Fail(message string) { p.settle(ToneFail, message) }

// Clear settles the step without a record: a live line is erased and a plain
// destination prints nothing.
func (p *Progress) Clear() {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.settled {
		return
	}
	p.settled = true
	if p.live {
		_, _ = io.WriteString(p.w, progressClearLine)
	}
}

func (p *Progress) settle(tone Tone, message string) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.settled {
		return
	}
	p.settled = true
	out := FormatNotice(p.caps, Notice{Prefix: p.prefix, Topic: p.topic, Tone: tone, Message: message})
	if p.live {
		out = progressClearLine + out
	}
	_, _ = io.WriteString(p.w, out)
}
