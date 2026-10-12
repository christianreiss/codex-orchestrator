package launchpad

import (
	"context"
	"errors"
	"io"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

// ErrCancelled reports that the operator left the launchpad without choosing.
var ErrCancelled = errors.New("launchpad cancelled")

// Run shows the launchpad on out and returns the selection. It returns only
// after Bubble Tea has restored the terminal, so the caller can hand the TTY
// straight to the engine; a one-line receipt is left in scrollback.
func Run(ctx context.Context, in io.Reader, out io.Writer, engines []Engine, last *Selection, caps terminalui.Caps) (Selection, error) {
	if len(engines) == 0 {
		return Selection{}, errors.New("no engine is assigned to this host")
	}
	p := newPicker(engines, last, caps)
	final, err := tea.NewProgram(p, tea.WithContext(ctx), tea.WithInput(in), tea.WithOutput(out)).Run()
	if err != nil {
		return Selection{}, err
	}
	p = final.(*picker)
	if p.cancelled || p.result == nil {
		return Selection{}, ErrCancelled
	}
	terminalui.PrintNotice(out, caps, terminalui.Notice{Prefix: personaPrefix(p.result.Engine), Topic: terminalui.TopicSession, Tone: terminalui.ToneDim, Message: Receipt(*p.result, caps.UTF8)})
	return *p.result, nil
}

// Receipt is the scrollback line for a selection, e.g.
// "Claude → claude-opus-5-5 · high · new".
func Receipt(s Selection, utf8 bool) string {
	arrow, dot := " → ", " · "
	if !utf8 {
		arrow, dot = " -> ", " - "
	}
	parts := []string{modelName(s.Model)}
	if s.Effort != "" {
		parts = append(parts, s.Effort)
	}
	parts = append(parts, s.Mode.String())
	return config.EngineLabel(s.Engine) + arrow + strings.Join(parts, dot)
}

func personaPrefix(engine string) string {
	switch engine {
	case config.EngineClaude:
		return "clx"
	case config.EngineGrok:
		return "cgx"
	}
	return "cdx"
}
