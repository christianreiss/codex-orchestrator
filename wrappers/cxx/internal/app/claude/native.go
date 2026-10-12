package claudeapp

import (
	"io"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/quotaadvice"
)

// RunNative preserves vendor argv and retains the managed launch/auth lifecycle.
func RunNative(args []string, stdout, stderr io.Writer) int {
	return runMode(args, stdout, stderr, true)
}
func RunNativeWithChoice(args []string, stdout, stderr io.Writer, choice *quotaadvice.Session) int {
	return runMode(args, stdout, stderr, true, choice)
}
func invocationFlags(args []string, native bool) (flags, []string, []string) {
	if !native {
		return parseFlags(args)
	}
	if at, ok := claude.NativeSubcommandIndex(args); ok {
		switch args[at] {
		case "auth", "login", "logout":
			return flags{helpPassthrough: nativeInformation(args)}, append([]string(nil), args[at:]...), nil
		default:
			// Maintenance commands must not receive interactive identity/session flags.
			return flags{helpPassthrough: nativeInformation(args)}, []string{"native-command"}, append([]string(nil), args...)
		}
	}

	return flags{helpPassthrough: nativeInformation(args)}, nil, append([]string(nil), args...)
}
func nativeInformation(args []string) bool {
	if len(args) == 1 && (args[0] == "--version" || args[0] == "-v") {
		return true
	}
	if len(args) > 0 && args[0] == "help" {
		return true
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if arg == "--help" || arg == "-h" {
			return true
		}
		i = claude.NativeOptionValueEnd(args, i)
	}
	return false
}
func nativeHeadless(args []string) bool {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if arg == "-p" || arg == "--print" || strings.HasPrefix(arg, "--print=") {
			return true
		}
		i = claude.NativeOptionValueEnd(args, i)
	}
	return false
}
func nativeResumed(args []string) bool {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if arg == "--continue" || arg == "-c" || arg == "--resume" || arg == "-r" || strings.HasPrefix(arg, "--resume=") {
			return true
		}
		i = claude.NativeOptionValueEnd(args, i)
	}
	return false
}

func nativeInstallerCommand(args []string) bool {
	if len(args) == 0 || nativeInformation(args) {
		return false
	}
	at, ok := claude.NativeSubcommandIndex(args)
	return ok && (args[at] == "install" || args[at] == "update" || args[at] == "upgrade")
}

func unsupportedNativeService(args []string) string {
	return claude.UnsupportedNativeService(args)
}
