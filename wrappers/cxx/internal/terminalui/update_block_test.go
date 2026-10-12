package terminalui

import (
	"bytes"
	"strings"
	"sync"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
)

func TestUpdateRunPlainFinishesInEngineOrder(t *testing.T) {
	var out bytes.Buffer
	u := StartUpdateRun(&out, Caps{}, []string{"Codex", "Claude", "Grok"})
	u.Row(2).Finish(ToneFail, "3", "download failed")
	u.Row(0).Finish(ToneOK, "1", "updated")
	u.Row(0).Finish(ToneFail, "wrong", "duplicate")
	u.Row(0).SetVersion("wrong")
	u.Row(1).Finish(ToneWarn, "2", "paused")
	if out.Len() != 0 {
		t.Fatal("worker wrote directly to output")
	}
	u.Close()
	u.Close()
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 3 || !strings.Contains(lines[0], "Codex") || !strings.Contains(lines[1], "Claude") || !strings.Contains(lines[2], "Grok") || strings.Contains(out.String(), "\x1b") || strings.Contains(out.String(), "wrong") {
		t.Fatalf("output=%q", out.String())
	}
}

func TestUpdateRunLiveProgressIsBoundedAndRestoresCursor(t *testing.T) {
	for _, width := range []int{40, 80, 120} {
		var out bytes.Buffer
		u := StartUpdateRun(&out, Caps{IsTTY: true, UTF8: true, Columns: width}, []string{"Codex", "Claude", "Grok"})
		u.Row(0).Observe(updateprogress.Event{Phase: "downloading", Artifact: "CLI", Bytes: 5 << 20, Total: 10 << 20})
		u.Row(1).Observe(updateprogress.Event{Phase: "installing"})
		u.Row(2).Observe(updateprogress.Event{Phase: "downloading", Bytes: 1 << 20, Total: -1})
		u.draw(true)
		u.Row(0).Observe(updateprogress.Event{Phase: "downloading", Artifact: "companion", Bytes: 2 << 20, Total: 4 << 20})
		u.draw(true)
		u.Row(0).Finish(ToneOK, "1", "updated")
		u.Row(1).Finish(ToneFail, "2", "checksum failed")
		u.Row(2).Finish(ToneWarn, "3", "sync paused")
		u.Close()
		output := out.String()
		if strings.Count(output, "\x1b[?25l") != 1 || strings.Count(output, "\x1b[?25h") != 1 || !strings.Contains(output, "\x1b[3A") || !strings.Contains(output, "checksum") {
			t.Fatalf("cursor or failure lost at width %d: %q", width, output)
		}
		if width >= 80 && (!strings.Contains(output, "CLI 50%") || !strings.Contains(output, "companion 50%") || !strings.Contains(output, "downloading 1.0M")) {
			t.Fatalf("progress labels missing: %q", output)
		}
		plain := strings.ReplaceAll(StripANSI(output), "\x1b[3A", "")
		for _, line := range strings.FieldsFunc(plain, func(r rune) bool { return r == '\r' || r == '\n' }) {
			if VisibleWidth(line) >= width {
				t.Fatalf("line wraps at %d: %q", width, line)
			}
		}
	}
}

func TestUpdateRunConcurrentEventsAndUnfinishedCleanup(t *testing.T) {
	var out bytes.Buffer
	u := StartUpdateRun(&out, Caps{IsTTY: true, UTF8: false, Columns: 80}, []string{"Codex", "Claude", "Grok"})
	var workers sync.WaitGroup
	for i := 0; i < 3; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			for n := int64(0); n < 100; n++ {
				u.Row(i).Observe(updateprogress.Event{Phase: "downloading", Bytes: n, Total: 100})
			}
		}(i)
	}
	workers.Wait()
	u.Close()
	if !strings.Contains(out.String(), "interrupted") || strings.Count(out.String(), "\x1b[?25h") != 1 {
		t.Fatal("unfinished rows or cursor lost", out.String())
	}
}
