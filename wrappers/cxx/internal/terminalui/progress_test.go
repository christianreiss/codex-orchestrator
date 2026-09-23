package terminalui

import (
	"bytes"
	"strings"
	"testing"
)

func TestRichProgressOverwritesItsOwnLine(t *testing.T) {
	var out bytes.Buffer
	p := StartProgress(&out, richTestCaps(80), "cdx", TopicSync, "syncing with orchestrator")
	started := out.String()
	if strings.Contains(started, "\n") || StripANSI(started) != "› cdx sync    syncing with orchestrator" {
		t.Fatalf("in-flight line = %q", StripANSI(started))
	}
	p.Done("synced with orchestrator")
	p.Fail("ignored after settle")
	p.Clear()
	got := strings.TrimPrefix(out.String(), started)
	if !strings.HasPrefix(got, progressClearLine) {
		t.Fatalf("result did not overwrite the in-flight line: %q", got)
	}
	if StripANSI(strings.TrimPrefix(got, progressClearLine)) != "✓ cdx sync    synced with orchestrator\n" {
		t.Fatalf("result line = %q", StripANSI(got))
	}
}

func TestRichProgressStaysOnOneRow(t *testing.T) {
	var out bytes.Buffer
	p := StartProgress(&out, richTestCaps(48), "clx", TopicUpdate, strings.Repeat("installing Claude CLI ", 6))
	line := StripANSI(out.String())
	if strings.Contains(line, "\n") || VisibleWidth(line) >= 48 {
		t.Fatalf("in-flight line does not fit one row: %q", line)
	}
	p.Fail("install failed")
	if !strings.HasSuffix(StripANSI(out.String()), "✗ clx update  install failed\n") {
		t.Fatalf("fail line = %q", StripANSI(out.String()))
	}
}

func TestRichProgressClearLeavesNoRecord(t *testing.T) {
	var out bytes.Buffer
	p := StartProgress(&out, richTestCaps(80), "cdx", TopicSync, "syncing with orchestrator")
	started := out.Len()
	p.Clear()
	p.Done("ignored after clear")
	if got := out.String()[started:]; got != progressClearLine {
		t.Fatalf("clear wrote %q", got)
	}
}

func TestPlainProgressPrintsOnlyTheResult(t *testing.T) {
	for _, caps := range []Caps{{}, MinimalCaps(richTestCaps(80)), {IsTTY: true, Columns: 39}} {
		var out bytes.Buffer
		p := StartProgress(&out, caps, "cdx", TopicUpload, "uploading credentials")
		if out.Len() != 0 {
			t.Fatalf("plain progress wrote before completion: %q", out.String())
		}
		p.Done("credentials uploaded")
		if got := out.String(); got != "cdx auth-upload: credentials uploaded\n" {
			t.Fatalf("plain result = %q", got)
		}
	}
	var out bytes.Buffer
	StartProgress(&out, Caps{}, "clx", TopicSync, "syncing").Clear()
	if out.Len() != 0 {
		t.Fatalf("plain clear wrote %q", out.String())
	}
}

func TestNilProgressIsQuiet(t *testing.T) {
	var p *Progress
	p.Done("x")
	p.Fail("x")
	p.Clear()
}
