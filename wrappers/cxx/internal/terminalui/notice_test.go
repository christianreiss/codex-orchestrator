package terminalui

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

func richTestCaps(columns int) Caps {
	return Caps{
		IsTTY: true, UTF8: true, Columns: columns,
		Palette:   Palette{Bold: "\x1b[1m", Dim: "\x1b[2m", Reset: "\x1b[0m", Green: "\x1b[32m", Orange: "\x1b[33m", Red: "\x1b[31m", Violet: "\x1b[35m"},
		BannerSym: BannerGlyphs{BoxH: "─"},
	}
}

func TestPlainNoticeKeepsGreppableSingleLine(t *testing.T) {
	long := "remove /tmp/" + strings.Repeat("a", 120) + "/auth.json: permission denied"
	got := FormatNotice(Caps{Columns: 40}, Notice{Prefix: "cdx", Topic: TopicUninstall, Tone: ToneFail, Message: long, Details: []string{"retry as root"}})
	want := "cdx uninstall: " + long + "\n  retry as root\n"
	if got != want {
		t.Fatalf("plain notice:\n got %q\nwant %q", got, want)
	}
	if got := FormatNotice(Caps{}, Notice{Prefix: "clx", Message: "ready"}); got != "clx: ready\n" {
		t.Fatalf("topic-less notice = %q", got)
	}
}

func TestPlainNoticeSanitizesForgedRows(t *testing.T) {
	got := FormatNotice(Caps{}, Notice{Prefix: "cdx", Topic: "auth", Message: "denied\n\x1b[31mcdx auth: forged → ok"})
	if strings.Count(got, "\n") != 1 || strings.Contains(got, "\x1b") || !strings.Contains(got, "->") {
		t.Fatalf("unsanitized plain notice: %q", got)
	}
}

func TestRichNoticeGrammarAndWidth(t *testing.T) {
	caps := richTestCaps(60)
	got := FormatNotice(caps, Notice{Prefix: "clx", Topic: TopicQuota, Tone: ToneWarn, Message: strings.Repeat("usage is high ", 8), Details: []string{"5h window: 97% used"}})
	plain := StripANSI(got)
	if !strings.HasPrefix(plain, "▲ clx quota   usage is high") {
		t.Fatalf("rich lead = %q", plain)
	}
	for _, line := range strings.Split(strings.TrimRight(plain, "\n"), "\n") {
		if VisibleWidth(line) > 60 {
			t.Fatalf("line exceeds width: %q", line)
		}
	}
	if !strings.Contains(got, "\x1b[35m\x1b[1mclx") {
		t.Fatalf("clx badge not in violet accent: %q", got)
	}
	if !strings.Contains(plain, "\n              5h window: 97% used\n") {
		t.Fatalf("detail does not hang under the message column: %q", plain)
	}
}

func TestRichNoticeASCIIFallback(t *testing.T) {
	caps := richTestCaps(80)
	caps.UTF8 = false
	got := StripANSI(FormatNotice(caps, Notice{Prefix: "cdx", Topic: TopicSync, Tone: ToneOK, Message: "Codex updated 1 → 2"}))
	if got != "+ cdx sync    Codex updated 1 -> 2\n" {
		t.Fatalf("ascii rich notice = %q", got)
	}
}

func TestLineSelectSemantics(t *testing.T) {
	q := Question{Prefix: "cdx", Topic: TopicQuota, Title: "Recommend Claude (clx)"}
	opts := []Option{{Key: "1", Label: "Keep OpenAI (cdx)"}, {Key: "2", Label: "Switch to Claude (clx)"}}
	for _, tc := range []struct {
		in, want string
		err      bool
	}{
		{in: "\n", want: "1"},
		{in: "2\n", want: "2"},
		{in: "q\n", err: true},
		{in: "maybe\n", err: true},
		{in: "", err: true},
	} {
		var out bytes.Buffer
		got, err := Select(context.Background(), Caps{}, strings.NewReader(tc.in), &out, q, opts, "1")
		if tc.err != errors.Is(err, ErrPromptCancelled) || (!tc.err && got != tc.want) {
			t.Fatalf("%q: got %q err %v", tc.in, got, err)
		}
		if !strings.Contains(out.String(), "cdx quota: Recommend Claude (clx)\n[1] Keep OpenAI (cdx)  [2] Switch to Claude (clx)  [q] Cancel  (Enter: 1): ") {
			t.Fatalf("line prompt = %q", out.String())
		}
	}
}

func TestLineConfirmSharesReaderWithoutReadAhead(t *testing.T) {
	in := strings.NewReader("yes\nn\n")
	var out bytes.Buffer
	q := Question{Prefix: "clx", Topic: TopicAuth, Title: "Continue?"}
	first, err := Confirm(context.Background(), Caps{}, in, &out, q)
	if err != nil || !first {
		t.Fatalf("first confirm = %v %v", first, err)
	}
	second, err := Confirm(context.Background(), Caps{}, in, &out, q)
	if err != nil || second {
		t.Fatalf("second confirm lost its line: %v %v", second, err)
	}
	if _, err := Confirm(context.Background(), Caps{}, in, &out, q); !errors.Is(err, ErrPromptCancelled) {
		t.Fatalf("EOF confirm err = %v", err)
	}
}

func TestLineConfirmHonoursContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r, w := io.Pipe()
	defer w.Close()
	if _, err := Confirm(ctx, Caps{}, r, &bytes.Buffer{}, Question{Title: "Continue?"}); !errors.Is(err, ErrPromptCancelled) {
		t.Fatalf("cancelled context err = %v", err)
	}
}

func TestForceMinimalReachesDeepCallers(t *testing.T) {
	SetForceMinimal(true)
	t.Cleanup(func() { SetForceMinimal(false) })
	caps := DetectCaps("")
	if caps.IsTTY || !caps.Dumb || caps.UTF8 || caps.Palette != (Palette{}) {
		t.Fatalf("forced minimal caps = %+v", caps)
	}
}
