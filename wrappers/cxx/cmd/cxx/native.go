package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	claudeapp "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/app/claude"
	codexapp "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/app/codex"
	grokapp "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/app/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeentry"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

func runNative(args []string, stdout, stderr io.Writer) int {
	if len(args) < 2 || args[1] != "--" {
		fmt.Fprintln(stderr, "usage: cxx native codex|claude|grok -- [native arguments]")
		return 2
	}
	switch args[0] {
	case "codex":
		return codexapp.RunNative(args[2:], stdout, stderr)
	case "claude":
		return claudeapp.RunNative(args[2:], stdout, stderr)
	case "grok":
		return grokapp.RunNative(args[2:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "cxx native: unknown engine %q\n", args[0])
		return 2
	}
}

func shouldReconcileNativeEntries(args []string) bool {
	if len(args) > 0 && args[0] == "native-entry" {
		return false
	}
	// Pure diagnostics and bridge/tool subprocesses must not install entrypoints.
	for _, arg := range args {
		if arg == "--" {
			break
		}
		switch arg {
		case "--help", "-h", "help", "--version", "-v", "-V", "--wrapper-version", "-W", "status", "doctor", "--status", "--doctor", "agent", "portal", "remote", "grok-auth", "claude-quota-statusline", "uninstall", "--uninstall":
			return false
		}
	}
	if len(args) >= 3 && args[0] == "native" {
		for _, arg := range args[3:] {
			if arg == "--" {
				break
			}
			if arg == "--version" || arg == "-v" || arg == "-V" || arg == "--help" || arg == "-h" {
				return false
			}
		}
	}
	return true
}

func reconcileNativeEntries(requireAssignment ...bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	// Unit tests call run directly; their executable is not a fleet artifact.
	if strings.HasSuffix(exe, ".test") {
		return nil
	}
	canonical, err := layout.CanonicalExecutable(exe)
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	key, err := signing.PublicKey()
	if err != nil {
		return err
	}
	var assigned []string
	for _, engine := range []string{"codex", "claude", "grok"} {
		path, err := configPathFor(engine)
		if err != nil {
			continue
		}
		cfg, err := config.LoadForEngine(path, key, false, engine)
		if err != nil {
			continue
		}
		for _, candidate := range nativeentry.AssignedEngines(cfg) {
			if candidate == engine {
				assigned = append(assigned, engine)
			}
		}
	}
	if len(assigned) == 0 {
		if len(requireAssignment) > 0 && requireAssignment[0] {
			return errors.New("no verified signed config with an explicit engine assignment; run cxx sync first")
		}
		return nil
	}
	// Adding entries cannot remove an engine on stale/offline assignment evidence.
	return nativeentry.Install(nativeentry.Options{Home: home, WrapperPath: canonical, Engines: assigned})
}

func runNativeEntry(args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "usage: cxx native-entry status|install|remove")
		return 2
	}
	home, err := os.UserHomeDir()
	if err == nil {
		switch args[0] {
		case "status":
			err = json.NewEncoder(stdout).Encode(nativeentry.Diagnose(home))
		case "install":
			err = reconcileNativeEntries(true)
		case "remove":
			err = nativeentry.Remove(nativeentry.Options{Home: home})
		default:
			err = errors.New("unknown native-entry command " + args[0])
		}
	}
	if err != nil {
		fmt.Fprintln(stderr, "cxx native-entry:", err)
		return 1
	}
	return 0
}
