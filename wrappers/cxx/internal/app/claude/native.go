package claudeapp

import (
	"io"
	"strings"

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
	if len(args) > 0 && (args[0] == "auth" || args[0] == "login" || args[0] == "logout") {
		return flags{helpPassthrough: nativeInformation(args)}, append([]string(nil), args...), nil
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
	for _, arg := range args {
		if arg == "--" {
			break
		}
		if arg == "--help" || arg == "-h" {
			return true
		}
	}
	return false
}
func nativeHeadless(args []string) bool {
	for _, arg := range args {
		if arg == "--" {
			break
		}
		if arg == "-p" || arg == "--print" || strings.HasPrefix(arg, "--print=") {
			return true
		}
	}
	return false
}
func nativeResumed(args []string) bool {
	for _, arg := range args {
		if arg == "--" {
			break
		}
		if arg == "--continue" || arg == "-c" || arg == "--resume" || arg == "-r" || strings.HasPrefix(arg, "--resume=") {
			return true
		}
	}
	return false
}

func nativeInstallerCommand(args []string) bool {
	if len(args) == 0 || nativeInformation(args) {
		return false
	}
	return args[0] == "install" || args[0] == "update" || args[0] == "upgrade"
}
