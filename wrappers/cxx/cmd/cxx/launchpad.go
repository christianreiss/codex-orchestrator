package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/term"

	claudeapp "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/app/claude"
	codexapp "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/app/codex"
	grokapp "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/app/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/launchpad"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/quotaadvice"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

// runLaunchpad is bare `cxx` on an attended terminal. ok=false means the
// launchpad does not apply here (pipes, scripts, no installed engine) and the
// caller prints the usage text exactly as before.
func runLaunchpad(stdout, stderr io.Writer) (code int, ok bool) {
	if !attendedTerminal(stdout, stderr) {
		return 0, false
	}
	key, err := signing.PublicKey()
	if err != nil {
		return 0, false
	}
	statePath, _ := launchpad.StatePath()
	last := launchpad.LoadLast(statePath)
	engines := launchpad.Discover(launchpad.Sources{
		Load: func(engine string) (*config.Config, error) {
			path, err := configPathFor(engine)
			if err != nil {
				return nil, err
			}
			return config.LoadForEngine(path, key, false, engine)
		},
		Installed: engineInstalled,
		Version: func(engine string) string {
			if engine != config.EngineCodex {
				return ""
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			return codex.Version(ctx)
		},
		Local: launchpad.LocalPreferences,
		Quota: launchpad.LocalWeekly,
		Last:  last,
	})
	if len(engines) == 0 {
		return 0, false
	}
	caps := terminalui.DetectCapsFor(stderr, "")
	selection, err := launchpad.Run(context.Background(), os.Stdin, stderr, engines, last, caps)
	if errors.Is(err, launchpad.ErrCancelled) {
		return 130, true
	}
	if err != nil {
		fmt.Fprintln(stderr, "cxx launchpad:", err)
		return 1, true
	}
	if statePath != "" {
		_ = launchpad.SaveLast(statePath, selection)
	}
	return launchSelection(selection, stdout, stderr), true
}

// launchSelection starts the engine through the managed native path. The
// operator just picked the engine, so the quota engine-switch chooser is
// skipped; hard quota enforcement still applies inside the lifecycle.
func launchSelection(s launchpad.Selection, stdout, stderr io.Writer) int {
	args := launchpad.NativeArgs(s)
	choice := &quotaadvice.Session{Selected: true, HasLaunchOptions: true, Available: engineInstalled}
	switch s.Engine {
	case config.EngineCodex:
		return codexapp.RunNativeWithChoice(args, stdout, stderr, choice)
	case config.EngineClaude:
		return claudeapp.RunNativeWithChoice(args, stdout, stderr, choice)
	case config.EngineGrok:
		// cgx's own `run` keeps the boot card that the native path skips.
		return grokapp.Run(append([]string{"run"}, args...), stdout, stderr)
	}
	fmt.Fprintf(stderr, "cxx launchpad: unknown engine %q\n", s.Engine)
	return 2
}

// engineInstalled mirrors the quota chooser's availability test. Grok is
// installed on demand by cgx itself, so it is always launchable.
func engineInstalled(engine string) bool {
	var err error
	switch engine {
	case config.EngineCodex:
		_, err = codex.FindCLI()
	case config.EngineClaude:
		_, err = claude.FindCLI()
	}
	return err == nil
}

// attendedTerminal requires a human on every stream: stdin for keys, both
// outputs on the terminal. Writers that are not files (tests) never qualify.
func attendedTerminal(stdout, stderr io.Writer) bool {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("TERM")), "dumb") {
		return false
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return false
	}
	for _, w := range []io.Writer{stdout, stderr} {
		f, isFile := w.(*os.File)
		if !isFile || !term.IsTerminal(int(f.Fd())) {
			return false
		}
	}
	return true
}
