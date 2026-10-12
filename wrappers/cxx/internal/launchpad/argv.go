package launchpad

import "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"

// Mode is how the chosen engine starts.
type Mode int

const (
	// ModeNew starts a fresh conversation.
	ModeNew Mode = iota
	// ModeContinue reopens the most recent conversation in this directory.
	ModeContinue
	// ModePick opens the native resume picker.
	ModePick
)

func (m Mode) String() string {
	switch m {
	case ModeContinue:
		return "continue"
	case ModePick:
		return "resume"
	}
	return "new"
}

// Selection is what the launchpad decided.
type Selection struct {
	Engine string `json:"engine"`
	Model  string `json:"model"`
	Effort string `json:"effort"`
	Mode   Mode   `json:"-"`
}

// NativeArgs is the vendor argv for a selection.
//
// Codex takes -m and --config at the root, where they also apply to the resume
// subcommand (`codex resume` has no -m of its own); --config rather than -c so
// the boot card reads the effort back. The bare effort value is not valid
// TOML, which Codex then takes as a literal string.
func NativeArgs(s Selection) []string {
	var args []string
	switch s.Engine {
	case config.EngineCodex:
		if s.Model != "" {
			args = append(args, "-m", s.Model)
		}
		if s.Effort != "" {
			args = append(args, "--config", "model_reasoning_effort="+s.Effort)
		}
		switch s.Mode {
		case ModeContinue:
			args = append(args, "resume", "--last")
		case ModePick:
			args = append(args, "resume")
		}
	case config.EngineClaude:
		if s.Model != "" {
			args = append(args, "--model", s.Model)
		}
		if s.Effort != "" {
			args = append(args, "--effort", s.Effort)
		}
		args = append(args, modeFlag(s.Mode)...)
	case config.EngineGrok:
		if s.Model != "" {
			args = append(args, "--model", s.Model)
		}
		if s.Effort != "" {
			args = append(args, "--reasoning-effort", s.Effort)
		}
		args = append(args, modeFlag(s.Mode)...)
	}
	return args
}

func modeFlag(m Mode) []string {
	switch m {
	case ModeContinue:
		return []string{"--continue"}
	case ModePick:
		return []string{"--resume"}
	}
	return nil
}
