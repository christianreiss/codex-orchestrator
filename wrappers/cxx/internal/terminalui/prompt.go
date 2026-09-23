package terminalui

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"charm.land/bubbles/v2/key"
	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"
	"golang.org/x/term"
)

// ErrPromptCancelled reports Ctrl-C, Esc, q, EOF, or a cancelled context.
// Callers map it to the same outcome as an explicit "Cancel" choice.
var ErrPromptCancelled = errors.New("prompt cancelled")

// Question is the shared header for Select and Confirm. Prefix/Topic place the
// question in the same notice grammar as every other wrapper message.
type Question struct {
	Prefix  string
	Topic   string
	Tone    Tone
	Title   string
	Details []string
}

// Option is one Select choice. Key is what a line-mode user types and what
// Select returns; Label is shown in both modes.
type Option struct {
	Key   string
	Label string
}

// Select asks for one option. Rich terminals get an arrow-key menu; every
// other destination gets a single line prompt on the same reader:
//
//	[1] Keep OpenAI (cdx)  [2] Switch to Claude (clx)  [q] Cancel (Enter: 1):
//
// In line mode Enter picks def, a listed key picks that option and anything
// else (including EOF) cancels, so an ambiguous answer never switches.
func Select(ctx context.Context, caps Caps, in io.Reader, out io.Writer, q Question, options []Option, def string) (string, error) {
	if len(options) == 0 {
		return "", ErrPromptCancelled
	}
	if def == "" {
		def = options[0].Key
	}
	if interactiveTerminal(caps, in, out) {
		return selectRich(ctx, caps, in, out, q, options, def)
	}
	printQuestionHeader(out, caps, q, true)
	fmt.Fprint(out, lineOptions(caps, q.Prefix, options, def))
	answer, err := readLine(ctx, in)
	if err != nil {
		return "", ErrPromptCancelled
	}
	if answer == "" {
		return def, nil
	}
	for _, o := range options {
		if strings.EqualFold(answer, o.Key) {
			return o.Key, nil
		}
	}
	return "", ErrPromptCancelled
}

// Confirm asks a yes/no question that defaults to No. Line mode accepts y or
// yes; any other answer is No and a read failure is ErrPromptCancelled.
func Confirm(ctx context.Context, caps Caps, in io.Reader, out io.Writer, q Question) (bool, error) {
	if interactiveTerminal(caps, in, out) {
		return confirmRich(ctx, caps, in, out, q)
	}
	printQuestionHeader(out, caps, q, false)
	fmt.Fprint(out, lineConfirm(caps, q))
	answer, err := readLine(ctx, in)
	if err != nil {
		return false, ErrPromptCancelled
	}
	return answer == "y" || answer == "yes", nil
}

// lineOptions renders the one-line menu. Plain destinations get the exact
// historical "[1] Label  [q] Cancel (Enter: 1): " form; styled terminals add
// the engine accent to the keys and mute the hint, never changing the text.
func lineOptions(caps Caps, prefix string, options []Option, def string) string {
	caps = engineCaps(caps, prefix)
	key, dim, reset := "", "", ""
	if !noticePlain(caps) {
		key, dim, reset = caps.BannerColor(), caps.Palette.Dim, caps.Palette.Reset
	}
	parts := make([]string, 0, len(options)+2)
	for _, o := range options {
		parts = append(parts, key+"["+PlainInline(o.Key)+"]"+reset+" "+lineLabel(caps, o.Label))
	}
	parts = append(parts, key+"[q]"+reset+" Cancel")
	parts = append(parts, dim+"(Enter: "+PlainInline(def)+")"+reset+":")
	width := promptWidth(caps)
	var lines []string
	for _, line := range packPieces(parts, width, 2) {
		if VisibleWidth(line) > width {
			// Only a very narrow terminal gets here; wrapping drops the
			// styling but keeps every word visible.
			lines = append(lines, WrapText(line, width)...)
			continue
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n") + " "
}

func lineConfirm(caps Caps, q Question) string {
	caps = engineCaps(caps, q.Prefix)
	width := promptWidth(caps)
	if noticePlain(caps) {
		return strings.Join(WrapText(PlainInline(q.Title)+" [y/N]:", width), "\n") + " "
	}
	p := caps.Palette
	tone := questionTone(q)
	lead := noticeGlyph(caps, tone) + " "
	lines := WrapText(inlineFor(caps, q.Title)+" [y/N]:", width-VisibleWidth(lead))
	var b strings.Builder
	for i, line := range lines {
		if i == 0 {
			b.WriteString(tonePalette(caps, tone) + lead + p.Reset)
		} else {
			b.WriteString("\n" + strings.Repeat(" ", VisibleWidth(lead)))
		}
		line = strings.Replace(line, "[y/N]:", p.Dim+"[y/N]"+p.Reset+":", 1)
		b.WriteString(p.Bold + line + p.Reset)
	}
	return b.String() + " "
}

// promptWidth leaves one cell for the cursor after the trailing space. Only
// real terminals wrap; a piped prompt stays on one line like a notice.
func promptWidth(caps Caps) int {
	if !caps.IsTTY {
		return 1 << 20
	}
	w := caps.Columns
	if w <= 0 {
		w = 80
	}
	if w > 2 {
		w -= 2
	}
	return w
}

func lineLabel(caps Caps, label string) string {
	if noticePlain(caps) {
		return PlainInline(label)
	}
	return inlineFor(caps, label)
}

// printQuestionHeader prints the context lines of a line-mode question. The
// title is part of the notice for Select and of the prompt line for Confirm.
func printQuestionHeader(out io.Writer, caps Caps, q Question, titleInNotice bool) {
	if titleInNotice {
		PrintNotice(out, caps, Notice{Prefix: q.Prefix, Topic: q.Topic, Tone: questionTone(q), Message: q.Title, Details: q.Details})
		return
	}
	if len(q.Details) > 0 {
		PrintNotice(out, caps, Notice{Prefix: q.Prefix, Topic: q.Topic, Tone: questionTone(q), Message: q.Details[0], Details: q.Details[1:]})
	}
}

func questionTone(q Question) Tone {
	if q.Tone == "" {
		return ToneWarn
	}
	return q.Tone
}

// interactiveTerminal requires a rich-capable destination and real terminal
// descriptors on both ends. Tests, pipes, --minimal and TERM=dumb all take
// the line path, which reads exactly one line from the caller's reader.
func interactiveTerminal(caps Caps, in io.Reader, out io.Writer) bool {
	if !caps.IsTTY || caps.Dumb || caps.Columns < minRichColumns {
		return false
	}
	fin, ok := in.(*os.File)
	if !ok || !term.IsTerminal(int(fin.Fd())) {
		return false
	}
	fout, ok := out.(*os.File)
	return ok && term.IsTerminal(int(fout.Fd()))
}

// readLine reads one answer and honours ctx cancellation. It reads byte by
// byte so a caller asking several questions on one reader never loses input
// to read-ahead. On cancellation the reading goroutine lingers until the next
// newline; every caller is about to exit or exec, so that is harmless.
func readLine(ctx context.Context, in io.Reader) (string, error) {
	type answer struct {
		text string
		err  error
	}
	ch := make(chan answer, 1)
	go func() {
		s, err := readOneLine(in)
		ch <- answer{s, err}
	}()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case a := <-ch:
		if a.err != nil && strings.TrimSpace(a.text) == "" {
			return "", a.err
		}
		return strings.ToLower(strings.TrimSpace(a.text)), nil
	}
}

func readOneLine(r io.Reader) (string, error) {
	var b strings.Builder
	buf := make([]byte, 1)
	for {
		n, err := r.Read(buf)
		if n == 1 {
			if buf[0] == '\n' {
				return b.String(), nil
			}
			b.WriteByte(buf[0])
		}
		if err != nil {
			return b.String(), err
		}
	}
}

func selectRich(ctx context.Context, caps Caps, in io.Reader, out io.Writer, q Question, options []Option, def string) (string, error) {
	value := def
	opts := make([]huh.Option[string], 0, len(options))
	for _, o := range options {
		opts = append(opts, huh.NewOption(CleanInline(o.Label), o.Key))
	}
	field := huh.NewSelect[string]().
		Title(richQuestionTitle(caps, q)).
		Description(strings.Join(cleanDetails(q.Details), "\n")).
		Options(opts...).
		Value(&value)
	if err := runForm(ctx, caps, in, out, q.Prefix, field); err != nil {
		return "", err
	}
	for _, o := range options {
		if o.Key == value {
			printReceipt(out, caps, q, o.Label)
		}
	}
	return value, nil
}

func confirmRich(ctx context.Context, caps Caps, in io.Reader, out io.Writer, q Question) (bool, error) {
	value := false
	field := huh.NewConfirm().
		Title(richQuestionTitle(caps, q)).
		Description(strings.Join(cleanDetails(q.Details), "\n")).
		Affirmative("Yes").
		Negative("No").
		Value(&value)
	if err := runForm(ctx, caps, in, out, q.Prefix, field); err != nil {
		return false, err
	}
	answer := "No"
	if value {
		answer = "Yes"
	}
	printReceipt(out, caps, q, answer)
	return value, nil
}

// printReceipt leaves one line in scrollback after an interactive prompt,
// which clears itself on exit: the question and the answer that was given.
func printReceipt(out io.Writer, caps Caps, q Question, answer string) {
	arrow := " → "
	if !caps.UTF8 {
		arrow = " -> "
	}
	PrintNotice(out, caps, Notice{Prefix: q.Prefix, Topic: q.Topic, Tone: ToneDim, Message: q.Title + arrow + answer})
}

func runForm(ctx context.Context, caps Caps, in io.Reader, out io.Writer, prefix string, field huh.Field) error {
	keys := huh.NewDefaultKeyMap()
	keys.Quit = key.NewBinding(key.WithKeys("ctrl+c", "esc", "q"), key.WithHelp("q", "cancel"))
	width := caps.Columns - 2
	if width > maxCardWidth {
		width = maxCardWidth
	}
	form := huh.NewForm(huh.NewGroup(field)).
		WithInput(in).
		WithOutput(out).
		WithKeyMap(keys).
		WithTheme(promptTheme(engineCaps(caps, prefix), prefix)).
		WithWidth(width).
		WithShowHelp(true)
	err := form.RunWithContext(ctx)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, huh.ErrUserAborted), errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return ErrPromptCancelled
	default:
		return err
	}
}

func richQuestionTitle(caps Caps, q Question) string {
	prefix := CleanInline(q.Prefix)
	if prefix == "" {
		prefix = "cxx"
	}
	head := noticeGlyph(caps, questionTone(q)) + " " + prefix
	if topic := CleanInline(q.Topic); topic != "" {
		head += " · " + topic
	}
	return head + "  " + CleanInline(q.Title)
}

func cleanDetails(details []string) []string {
	out := make([]string, 0, len(details))
	for _, d := range details {
		if d = CleanInline(d); d != "" {
			out = append(out, d)
		}
	}
	return out
}

// promptTheme maps the wrapper design tokens onto huh so a prompt reads as
// part of the same product as the boot card: engine accent for focus, muted
// descriptions, and the shared green/red for the confirm buttons.
func promptTheme(caps Caps, prefix string) huh.Theme {
	accentHex := hexOrange
	switch {
	case caps.Theme == ThemeViolet || strings.EqualFold(prefix, "clx"):
		accentHex = hexViolet
	case caps.Theme == ThemePink:
		accentHex = hexPink
	}
	return huh.ThemeFunc(func(isDark bool) *huh.Styles {
		t := huh.ThemeBase(isDark)
		accent := lipgloss.Color(accentHex)
		muted := lipgloss.Color(hexMuted)
		ink := lipgloss.LightDark(isDark)(lipgloss.Color("#1F2330"), lipgloss.Color("#E6E8F0"))
		chip := lipgloss.LightDark(isDark)(lipgloss.Color("#E6E8F0"), lipgloss.Color("#2A2E3B"))
		onAccent := lipgloss.Color("#101218")

		t.Focused.Base = t.Focused.Base.BorderForeground(accent)
		t.Focused.Card = t.Focused.Base
		t.Focused.Title = lipgloss.NewStyle().Foreground(ink).Bold(true)
		t.Focused.Description = lipgloss.NewStyle().Foreground(muted)
		t.Focused.SelectSelector = lipgloss.NewStyle().Foreground(accent).SetString("❯ ")
		t.Focused.Option = lipgloss.NewStyle().Foreground(ink)
		t.Focused.SelectedOption = lipgloss.NewStyle().Foreground(accent).Bold(true)
		t.Focused.ErrorIndicator = t.Focused.ErrorIndicator.Foreground(lipgloss.Color(hexRed))
		t.Focused.ErrorMessage = t.Focused.ErrorMessage.Foreground(lipgloss.Color(hexRed))
		t.Focused.FocusedButton = t.Focused.FocusedButton.Foreground(onAccent).Background(accent).Bold(true)
		t.Focused.BlurredButton = t.Focused.BlurredButton.Foreground(ink).Background(chip)
		t.Focused.Next = t.Focused.FocusedButton

		t.Blurred = t.Focused
		t.Blurred.Base = t.Focused.Base.BorderStyle(lipgloss.HiddenBorder())
		t.Blurred.Card = t.Blurred.Base
		t.Group.Title = t.Focused.Title
		t.Group.Description = t.Focused.Description
		t.Help.ShortKey = lipgloss.NewStyle().Foreground(muted)
		t.Help.ShortDesc = lipgloss.NewStyle().Foreground(muted).Faint(true)
		t.Help.ShortSeparator = lipgloss.NewStyle().Foreground(muted).Faint(true)
		return t
	})
}
