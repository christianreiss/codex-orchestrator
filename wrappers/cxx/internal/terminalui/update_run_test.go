package terminalui

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
)

func TestUpdateRowPlainProducesOnlyOneCompletion(t *testing.T) {
	var out bytes.Buffer
	r := StartUpdateRow(&out, Caps{Columns: 80}, "Grok", "1.0.0")
	r.Observe(updateprogress.Event{Phase: "downloading", Bytes: 20, Total: 100})
	if out.Len() != 0 {
		t.Fatal("plain destination printed progress")
	}
	r.Finish(ToneOK, "1.0.0", "up to date · synced")
	r.Finish(ToneFail, "", "duplicate")
	if strings.Count(out.String(), "\n") != 1 || strings.Contains(out.String(), "\x1b") || !strings.Contains(out.String(), "up to date | synced") {
		t.Fatalf("output=%q", out.String())
	}
}

func TestUpdateRowDownloadProgressAndCursorCleanup(t *testing.T) {
	for _, width := range []int{40, 80} {
		t.Run(string(rune(width)), func(t *testing.T) {
			var out bytes.Buffer
			r := StartUpdateRow(&out, Caps{IsTTY: true, UTF8: true, Columns: width}, "Codex", "1.0.0")
			r.Observe(updateprogress.Event{Phase: "downloading", Bytes: 5 << 20, Total: 10 << 20})
			// Draw deterministically instead of relying on a timer in the test.
			r.mu.Lock()
			r.draw()
			r.mu.Unlock()
			r.Finish(ToneFail, "1.0.0", "interrupted")
			if !strings.Contains(out.String(), "\x1b[?25h") || !strings.Contains(out.String(), "interrupted") {
				t.Fatalf("output=%q", out.String())
			}
			if width == 80 && !strings.Contains(out.String(), "5.0M/10.0M") {
				t.Fatalf("missing measured progress: %q", out.String())
			}
			for _, line := range strings.Split(out.String(), "\r") {
				if line == "" {
					continue
				}
				if VisibleWidth(strings.TrimSuffix(line, "\n")) >= width {
					t.Fatalf("row wraps at width %d: %q", width, line)
				}
			}
		})
	}
}

func TestUpdateRowUnknownLengthAnimatesWithoutPercentage(t *testing.T) {
	var out bytes.Buffer
	r := StartUpdateRow(&out, Caps{IsTTY: true, UTF8: true, Columns: 80}, "Claude", "2.0.0")
	r.Observe(updateprogress.Event{Phase: "downloading", Bytes: 1 << 20, Total: -1})
	r.mu.Lock()
	r.draw()
	r.mu.Unlock()
	time.Sleep(110 * time.Millisecond)
	r.Finish(ToneOK, "2.0.0", "updated")
	if strings.Contains(out.String(), "%") || !strings.Contains(out.String(), "downloading 1.0M") || !strings.Contains(out.String(), "⠙") {
		t.Fatalf("output=%q", out.String())
	}
}
