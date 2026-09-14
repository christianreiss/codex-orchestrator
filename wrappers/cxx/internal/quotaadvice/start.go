package quotaadvice

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
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
		fmt.Fprintln(os.Stderr, "quota: daily choice storage unavailable")
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
	reader := bufio.NewReader(u.Input)
	selected := ""
	remembered := false
	if u.Interactive && c.Settings.Mode == "ask" && c.Settings.RememberDay {
		if day := LoadChoice(u.StatePath, u.Instance, u.Now); day != nil {
			if u.Available(day.Engine) {
				selected = day.Engine
				remembered = true
				fmt.Fprintf(u.Output, "quota: using today's choice: %s (until local midnight; undo with --quota-choice-reset)\n", Name(selected))
			} else {
				if err := ClearChoice(u.StatePath); err != nil {
					fmt.Fprintln(u.Output, "quota: daily choice could not be cleared; ignoring unavailable provider")
				} else {
					fmt.Fprintln(u.Output, "quota: today's provider is unavailable; daily choice cleared")
				}
				fmt.Fprintf(u.Output, "Start originally requested %s instead? [y/N]: ", Name(current))
				answer, err := readAnswer(ctx, reader)
				if err != nil || (answer != "y" && answer != "yes") {
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
			fmt.Fprintf(u.Output, "quota comparison unavailable: %s: %s; %s: %s\n", Name(current), a.Description(u.Now), Name(other(current)), b.Description(u.Now))
			return stay, nil
		}
		if !Recommend(a, b, c.Settings) || !u.Available(other(current)) {
			return stay, nil
		}
		fmt.Fprintf(u.Output, "quota: recommend %s\n  %s: %s\n  %s: %s\n", Name(other(current)), Name(current), a.Description(u.Now), Name(other(current)), b.Description(u.Now))
		if !u.Interactive || c.Settings.Mode != "ask" {
			return stay, nil
		}
		fmt.Fprintf(u.Output, "[1] Start %s  [2] Start %s  [q] Cancel (Enter: keep %s): ", Name(current), Name(other(current)), Name(current))
		answer, err := readAnswer(ctx, reader)
		if err != nil {
			return Choice{Cancel: true}, nil
		}
		switch answer {
		case "", "1":
			selected = current
		case "2":
			selected = other(current)
		case "q":
			return Choice{Cancel: true}, nil
		default:
			return Choice{Cancel: true}, nil
		}
	}
	if selected != current && hasArgs {
		fmt.Fprint(u.Output, "Switch starts a NEW session here, without the previous conversation, supplied prompt or launch arguments. Continue? [y/N]: ")
		answer, err := readAnswer(ctx, reader)
		if err != nil {
			return Choice{Cancel: true}, nil
		}
		if answer != "y" && answer != "yes" {
			return stay, nil
		}
	}
	if !remembered && c.Settings.RememberDay && u.Interactive && c.Settings.Mode == "ask" {
		fmt.Fprint(u.Output, "Remember this provider for today on this computer? [y/N]: ")
		answer, err := readAnswer(ctx, reader)
		if err != nil {
			return Choice{Cancel: true}, nil
		}
		if answer == "y" || answer == "yes" {
			if err := SaveChoice(u.StatePath, u.Instance, selected, u.Now); err != nil {
				fmt.Fprintln(u.Output, "quota: could not save daily choice; selection applies to this start only")
			}
		}
	}
	u.decisionApplied = true
	return Choice{Engine: selected}, nil
}
func readAnswer(ctx context.Context, r *bufio.Reader) (string, error) {
	type answer struct {
		text string
		err  error
	}
	ch := make(chan answer, 1)
	go func() { s, e := r.ReadString('\n'); ch <- answer{s, e} }()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case a := <-ch:
		return strings.ToLower(strings.TrimSpace(a.text)), a.err
	}
}

// RetryOriginal offers one bounded recovery after the chosen provider refuses
// before launching. Never reinterpret a failure of an actual agent session.
func RetryOriginal(s *Session, original string, out io.Writer) bool {
	if s.Instance != "" {
		if err := Reset(s.Instance); err != nil {
			fmt.Fprintln(out, "quota: could not clear daily choice:", err)
			return false
		}
	}
	fmt.Fprintf(out, "quota: selected provider could not start; daily choice cleared. Try originally requested %s? [y/N]: ", Name(original))
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	return err == nil && strings.EqualFold(strings.TrimSpace(line), "y")
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
