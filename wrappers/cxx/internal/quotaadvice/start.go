package quotaadvice

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
	"golang.org/x/term"
)

// Session is owned by the multicall dispatcher. A switch is performed only
// after the original persona has returned and released all its auth leases.
type Session struct {
	Armed            bool
	HasLaunchOptions bool
	DecisionApplied  bool
	Selected         bool
	Request          string
	Started          bool
	Instance         string
	ConfigPath       string
	Available        func(string) bool
}
type sessionKey struct{}

func WithSession(ctx context.Context, s *Session) context.Context {
	return context.WithValue(ctx, sessionKey{}, s)
}
func CurrentSession(ctx context.Context) *Session {
	s, _ := ctx.Value(sessionKey{}).(*Session)
	return s
}
func MarkStarted(ctx context.Context) {
	if s := CurrentSession(ctx); s != nil && s.Armed {
		s.Started = true
	}
}
func Reset(instance string) error {
	p, err := StatePath(instance)
	if err != nil {
		return err
	}
	return ClearChoice(p)
}
func Name(engine string) string {
	if engine == "codex" {
		return "OpenAI (cdx)"
	}
	return "Claude (clx)"
}
func other(engine string) string {
	if engine == "codex" {
		return "claude"
	}
	return "codex"
}
func localConfigured(engine, instance string) bool {
	path, err := config.DefaultPathForEngine(engine)
	if err != nil {
		return false
	}
	key, err := signing.PublicKey()
	if err != nil {
		return false
	}
	cfg, err := config.LoadForEngine(path, key, false, engine)
	return err == nil && strings.TrimRight(cfg.Orchestrator.BaseURL, "/") == strings.TrimRight(instance, "/")
}

// BeforeStart returns stop=true on a requested switch or user cancellation.
// An absent Session still allows noninteractive advisory output, never dispatch.
func BeforeStart(ctx context.Context, cfg *config.Config, c *Comparison, args []string, headless, reset bool) (stop bool, code int, err error) {
	instance := cfg.Orchestrator.BaseURL
	if reset {
		if err = Reset(instance); err != nil {
			return true, 1, fmt.Errorf("reset daily quota choice: %w", err)
		}
	}
	s := CurrentSession(ctx)
	if s != nil {
		s.Instance = instance
		s.ConfigPath = cfg.SourcePath()
	}
	if c == nil || !c.Settings.valid() || c.Settings.Mode == "off" || (s != nil && s.Selected) {
		return false, 0, nil
	}
	interactive := !headless && !automatedArgs(cfg.Engine, args) && term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stderr.Fd())) && s != nil
	available := func(engine string) bool {
		if engine == cfg.Engine {
			return true
		}
		return c.Snapshot(engine).Available && localConfigured(engine, instance) && (s == nil || s.Available == nil || s.Available(engine))
	}
	path, pathErr := StatePath(instance)
	chooser := Chooser{Input: os.Stdin, Output: os.Stderr, Now: time.Now(), Interactive: interactive, Available: available, StatePath: path, Instance: instance}
	result, err := chooser.Choose(ctx, c, cfg.Engine, len(args) > 0 || (s != nil && s.HasLaunchOptions))
	if err != nil {
		return true, 1, err
	}
	if s != nil {
		s.DecisionApplied = chooser.decisionApplied
	}
	if result.Cancel {
		return true, 130, nil
	}
	if result.Engine != "" && result.Engine != cfg.Engine && s != nil {
		s.Request = result.Engine
		return true, 0, nil
	}
	if pathErr != nil && c.Settings.RememberDay {
		terminalui.Say(os.Stderr, personaPrefix(cfg.Engine), terminalui.ToneWarn, terminalui.TopicQuota, "Daily choice storage unavailable")
	}
	return false, 0, nil
}

type Choice struct {
	Engine string
	Cancel bool
}
type Chooser struct {
	decisionApplied bool
	Input           io.Reader
	Output          io.Writer
	Now             time.Time
	Interactive     bool
	Available       func(string) bool
	StatePath       string
	Instance        string
}

func (u *Chooser) Choose(ctx context.Context, c *Comparison, current string, hasArgs bool) (Choice, error) {
	stay := Choice{Engine: current}
	if c == nil || !c.Settings.valid() || c.Settings.Mode == "off" {
		return stay, nil
	}
	caps := terminalui.DetectCapsFor(u.Output, "")
	prefix := personaPrefix(current)
	say := func(tone terminalui.Tone, msg string, details ...string) {
		terminalui.PrintNotice(u.Output, caps, terminalui.Notice{Prefix: prefix, Topic: terminalui.TopicQuota, Tone: tone, Message: msg, Details: details})
	}
	confirm := func(title string, details ...string) (bool, error) {
		return terminalui.Confirm(ctx, caps, u.Input, u.Output, terminalui.Question{Prefix: prefix, Topic: terminalui.TopicQuota, Title: title, Details: details})
	}
	selected := ""
	remembered := false
	if u.Interactive && c.Settings.Mode == "ask" && c.Settings.RememberDay {
		if day := LoadChoice(u.StatePath, u.Instance, u.Now); day != nil {
			if u.Available(day.Engine) {
				selected = day.Engine
				remembered = true
				say(terminalui.ToneDim, "Using today's choice: "+Name(selected), "until local midnight; undo with --quota-choice-reset")
			} else {
				if err := ClearChoice(u.StatePath); err != nil {
					say(terminalui.ToneWarn, "Daily choice could not be cleared; ignoring the unavailable provider")
				} else {
					say(terminalui.ToneWarn, "Today's provider is unavailable; daily choice cleared")
				}
				ok, err := confirm("Start originally requested " + Name(current) + " instead?")
				if err != nil || !ok {
					return Choice{Cancel: true}, nil
				}
				selected = current
			}
		}
	}
	if selected == "" {
		a := Evaluate(c.Snapshot(current), c.Settings, u.Now)
		b := Evaluate(c.Snapshot(other(current)), c.Settings, u.Now)
		if !a.Valid || !b.Valid {
			say(terminalui.ToneDim, "Quota comparison unavailable",
				Name(current)+": "+a.Description(u.Now),
				Name(other(current))+": "+b.Description(u.Now))
			return stay, nil
		}
		if !Recommend(a, b, c.Settings) || !u.Available(other(current)) {
			return stay, nil
		}
		details := []string{
			Name(current) + ": " + a.Description(u.Now),
			Name(other(current)) + ": " + b.Description(u.Now),
		}
		if !u.Interactive || c.Settings.Mode != "ask" {
			say(terminalui.ToneWarn, "Recommend "+Name(other(current)), details...)
			return stay, nil
		}
		answer, err := terminalui.Select(ctx, caps, u.Input, u.Output, terminalui.Question{
			Prefix: prefix, Topic: terminalui.TopicQuota, Tone: terminalui.ToneWarn,
			Title:   "Recommend " + Name(other(current)),
			Details: details,
		}, []terminalui.Option{
			{Key: "1", Label: "Keep " + Name(current)},
			{Key: "2", Label: "Switch to " + Name(other(current))},
		}, "1")
		if err != nil {
			return Choice{Cancel: true}, nil
		}
		selected = current
		if answer == "2" {
			selected = other(current)
		}
	}
	if selected != current && hasArgs {
		ok, err := confirm("Continue in a new session?", "Switching starts a NEW session here, without the previous conversation, supplied prompt or launch arguments.")
		if err != nil {
			return Choice{Cancel: true}, nil
		}
		if !ok {
			return stay, nil
		}
	}
	if !remembered && c.Settings.RememberDay && u.Interactive && c.Settings.Mode == "ask" {
		ok, err := confirm("Remember " + Name(selected) + " for today on this computer?")
		if err != nil {
			return Choice{Cancel: true}, nil
		}
		if ok {
			if err := SaveChoice(u.StatePath, u.Instance, selected, u.Now); err != nil {
				say(terminalui.ToneWarn, "Could not save the daily choice; this selection applies to this start only")
			}
		}
	}
	u.decisionApplied = true
	return Choice{Engine: selected}, nil
}

func personaPrefix(engine string) string {
	if engine == "codex" {
		return "cdx"
	}
	return "clx"
}

// RetryOriginal offers one bounded recovery after the chosen provider refuses
// before launching. Never reinterpret a failure of an actual agent session.
func RetryOriginal(s *Session, original string, out io.Writer) bool {
	caps := terminalui.DetectCapsFor(out, "")
	prefix := personaPrefix(original)
	if s.Instance != "" {
		if err := Reset(s.Instance); err != nil {
			terminalui.PrintNotice(out, caps, terminalui.Notice{Prefix: prefix, Topic: terminalui.TopicQuota, Tone: terminalui.ToneFail, Message: "Could not clear the daily choice", Details: []string{err.Error()}})
			return false
		}
	}
	ok, err := terminalui.Confirm(context.Background(), caps, os.Stdin, out, terminalui.Question{
		Prefix: prefix, Topic: terminalui.TopicQuota, Tone: terminalui.ToneFail,
		Title:   "Start originally requested " + Name(original) + "?",
		Details: []string{"The selected provider could not start; daily choice cleared."},
	})
	return err == nil && ok
}

func automatedArgs(engine string, args []string) bool {
	for _, arg := range args {
		if arg == "--" {
			break
		}
		if engine == "claude" && (arg == "-p" || arg == "--print" || strings.HasPrefix(arg, "--print=")) {
			return true
		}
		if engine == "codex" && (arg == "exec" || arg == "--json") {
			return true
		}
	}
	return false
}

// ArmLaunch excludes auth recovery/login children from agent-start accounting.
func ArmLaunch(ctx context.Context) {
	if s := CurrentSession(ctx); s != nil {
		s.Armed = true
	}
}
