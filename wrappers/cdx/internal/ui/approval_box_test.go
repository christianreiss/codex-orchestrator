package ui

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"
)

type countingApprovalChecker struct {
	calls int
}

func (c *countingApprovalChecker) CheckAuthStatus(context.Context) (string, string, error) {
	c.calls++
	return "insecure", "", nil
}

func TestPollApprovalRejectsUnsafeTerminalWithoutDrawingOrPolling(t *testing.T) {
	tests := []struct {
		name string
		caps Caps
	}{
		{name: "redirected stderr", caps: Caps{IsTTY: false, Columns: 80}},
		{name: "dumb terminal", caps: Caps{IsTTY: true, Dumb: true, Columns: 80}},
		{name: "unknown width", caps: Caps{IsTTY: true, Columns: 0}},
		{name: "too narrow", caps: Caps{IsTTY: true, Columns: minApprovalColumns - 1}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			checker := &countingApprovalChecker{}
			var out bytes.Buffer

			resolved, err := pollApproval(context.Background(), checker, time.Millisecond, tc.caps, &out)
			if resolved {
				t.Fatal("unsafe terminal unexpectedly resolved approval")
			}
			if err == nil {
				t.Fatal("unsafe terminal did not return an actionable error")
			}
			if !strings.Contains(err.Error(), "Admin -> Host Detail") || !strings.Contains(err.Error(), "enable this host window") {
				t.Fatalf("error is not actionable: %q", err)
			}
			if checker.calls != 0 {
				t.Fatalf("auth checker called %d times; want 0", checker.calls)
			}
			if out.Len() != 0 {
				t.Fatalf("unsafe terminal emitted output: %q", out.String())
			}
		})
	}
}

func TestDrawApprovalBoxSanitizesAndTruncatesDynamicText(t *testing.T) {
	caps := asciiApprovalCaps(52)
	started := time.Date(2026, time.July, 15, 10, 0, 0, 0, time.UTC)
	var out bytes.Buffer
	drawApprovalBox(&out, caps, approvalBoxData{
		StartedAt: started,
		LastCheck: started.Add(65 * time.Second),
		Checks:    12,
		Status:    "insecure",
		Reason: "\x1b[31mdenied\x1b[0m\nFORGED\r\t" +
			strings.Repeat("very-long-reason ", 12) + "\x00\x1b[2J",
	})

	rendered := out.String()
	if strings.Contains(rendered, "\x1b") || strings.Contains(rendered, "\x00") {
		t.Fatalf("rendered box contains terminal controls: %q", rendered)
	}
	if !strings.Contains(rendered, "denied FORGED") {
		t.Fatalf("newlines were not safely collapsed: %q", rendered)
	}
	if !strings.Contains(rendered, "...") {
		t.Fatalf("long dynamic content was not truncated: %q", rendered)
	}

	lines := boxOutputLines(t, rendered)
	wantWidth := approvalBoxWidth(caps.Columns)
	for i, line := range lines {
		if got := VisibleWidth(line); got != wantWidth {
			t.Errorf("line %d width = %d, want %d: %q", i, got, wantWidth, line)
		}
		assertNoControlCharacters(t, line)
	}
}

func TestDrawApprovalBoxNeverExpandsNarrowWidth(t *testing.T) {
	caps := asciiApprovalCaps(18)
	started := time.Date(2026, time.July, 15, 10, 0, 0, 0, time.UTC)
	var out bytes.Buffer
	drawApprovalBox(&out, caps, approvalBoxData{
		StartedAt: started,
		LastCheck: started.Add(2*time.Hour + 3*time.Minute),
		Checks:    999,
		Status:    "insecure-with-a-long-status",
		Reason:    strings.Repeat("reason ", 10),
	})

	lines := boxOutputLines(t, out.String())
	wantWidth := approvalBoxWidth(caps.Columns)
	for i, line := range lines {
		if got := VisibleWidth(line); got != wantWidth {
			t.Errorf("line %d width = %d, want %d: %q", i, got, wantWidth, line)
		}
		if VisibleWidth(line) > caps.Columns {
			t.Errorf("line %d exceeds terminal width %d: %q", i, caps.Columns, line)
		}
	}
	if !strings.Contains(out.String(), "...") {
		t.Fatalf("narrow box did not truncate content: %q", out.String())
	}
}

func asciiApprovalCaps(columns int) Caps {
	return Caps{
		IsTTY:   true,
		UTF8:    false,
		Columns: columns,
		BannerSym: BannerGlyphs{
			BoxTL: "+",
			BoxTR: "+",
			BoxBL: "+",
			BoxBR: "+",
			BoxH:  "-",
			BoxV:  "|",
		},
	}
}

func boxOutputLines(t *testing.T, rendered string) []string {
	t.Helper()
	if got := strings.Count(rendered, "\n"); got != approvalBoxLines {
		t.Fatalf("box emitted %d lines, want %d: %q", got, approvalBoxLines, rendered)
	}
	return strings.Split(strings.TrimSuffix(rendered, "\n"), "\n")
}

func assertNoControlCharacters(t *testing.T, s string) {
	t.Helper()
	for _, r := range s {
		if r < 0x20 || (r >= 0x7f && r <= 0x9f) {
			t.Fatalf("line contains control character %U: %q", r, s)
		}
	}
}
