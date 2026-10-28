package claude

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const officialAnthropicBaseURL = "https://api.anthropic.com"
const staleRuntimeAuthSettingsAge = 7 * 24 * time.Hour

// claudeTopLevelSubcommands names the tokens injectRuntimeAuthSettings treats as
// a subcommand rather than a prompt, so the settings overlay lands before them.
// It has to cover every name in cmd/clx's reservedClaudeSubcommands — those are
// forwarded verbatim — which the clx-claude-subcommand-parity contract test
// holds it to.
var claudeTopLevelSubcommands = map[string]struct{}{
	"agents":      {},
	"attach":      {},
	"auth":        {},
	"auto-mode":   {},
	"config":      {},
	"doctor":      {},
	"gateway":     {},
	"help":        {},
	"import":      {},
	"install":     {},
	"kill":        {},
	"login":       {},
	"logout":      {},
	"logs":        {},
	"mcp":         {},
	"plugin":      {},
	"plugins":     {},
	"project":     {},
	"purge":       {},
	"respawn":     {},
	"rm":          {},
	"setup-token": {},
	"stop":        {},
	"ultrareview": {},
	"update":      {},
	"upgrade":     {},
}

// Native root parser flags verified against Claude Code 2.1.312 on 2026-10-28.
// Required, optional and variadic values have different consumption rules: a
// command-looking value must never become a subcommand or an auth operation.
var claudeGlobalOptionsWithValue = map[string]struct{}{
	"--add-dir":                            {},
	"--advisor":                            {},
	"--agent":                              {},
	"--agent-color":                        {},
	"--agent-id":                           {},
	"--agent-name":                         {},
	"--agent-type":                         {},
	"--agents":                             {},
	"--allowed-tools":                      {},
	"--allowedTools":                       {},
	"--append-subagent-system-prompt":      {},
	"--append-subagent-system-prompt-file": {},
	"--append-system-prompt":               {},
	"--append-system-prompt-file":          {},
	"--attach-serve":                       {},
	"--autocompact":                        {},
	"--betas":                              {},
	"--channels":                           {},
	"--client-data-url":                    {},
	"--correlation-id":                     {},
	"--config":                             {},
	"--cwd":                                {},
	"--dangerously-load-development-channels": {},
	"--debug-file":                         {},
	"--deep-link-cwd-b64":                  {},
	"--deep-link-last-fetch":               {},
	"--deep-link-repo":                     {},
	"--disallowed-tools":                   {},
	"--disallowedTools":                    {},
	"--effort":                             {},
	"--environment":                        {},
	"--fallback-model":                     {},
	"--file":                               {},
	"--forward-home-settings":              {},
	"--inherit-permission-mode":            {},
	"--input-format":                       {},
	"--json-schema":                        {},
	"--managed-settings":                   {},
	"--max-budget-usd":                     {},
	"--max-thinking-tokens":                {},
	"--max-turns":                          {},
	"--mcp-config":                         {},
	"--messaging-socket-path":              {},
	"--model":                              {},
	"--name":                               {},
	"--on-branch":                          {},
	"--output-format":                      {},
	"--parent-session-id":                  {},
	"--permission-mode":                    {},
	"--permission-prompt-tool":             {},
	"--permission-prompts":                 {},
	"--plan-mode-instructions":             {},
	"--plugin-dir":                         {},
	"--plugin-dir-no-mcp":                  {},
	"--plugin-url":                         {},
	"--pool":                               {},
	"--prefill":                            {},
	"--prefill-b64":                        {},
	"--proactivity":                        {},
	"--project-config-root":                {},
	"--ref":                                {},
	"--remote-control-session-name-prefix": {},
	"--resume-drops-turn":                  {},
	"--resume-session-at":                  {},
	"--rewind-files":                       {},
	"--sdk-url":                            {},
	"--session-id":                         {},
	"--setting-sources":                    {},
	"--settings":                           {},
	"--system-prompt":                      {},
	"--system-prompt-file":                 {},
	"--system-prompt-snapshot":             {},
	"--task-budget":                        {},
	"--team-name":                          {},
	"--teammate-mode":                      {},
	"--thinking":                           {},
	"--thinking-display":                   {},
	"--tools":                              {},
	"--watch-artifact":                     {},
	"--watch-artifact-no-autoreact":        {},
	"--workload":                           {},
	"-n":                                   {},
}

var claudeGlobalOptionsWithOptionalValue = map[string]struct{}{
	"--cloud":              {},
	"--debug":              {},
	"--from-pr":            {},
	"--prompt-suggestions": {},
	"--rc":                 {},
	"--remote":             {},
	"--remote-control":     {},
	"--resume":             {},
	"--teleport":           {},
	"--worktree":           {},
	"-d":                   {},
	"-r":                   {},
	"-w":                   {},
}

var claudeGlobalVariadicOptions = map[string]struct{}{
	"--add-dir":       {},
	"--allowed-tools": {},
	"--allowedTools":  {},
	"--betas":         {},
	"--channels":      {},
	"--dangerously-load-development-channels": {},
	"--disallowed-tools":                      {},
	"--disallowedTools":                       {},
	"--file":                                  {},
	"--mcp-config":                            {},
	"--tools":                                 {},
}

// NativeOptionValueEnd returns the last argv index consumed by an option.
// An equals-form value is already part of the option. Only separate optional
// and additional variadic values stop at a following option or literal separator.
func NativeOptionValueEnd(args []string, at int) int {
	arg := args[at]
	name, _, inline := strings.Cut(arg, "=")
	_, required := claudeGlobalOptionsWithValue[name]
	_, optional := claudeGlobalOptionsWithOptionalValue[name]
	if !inline && required && at+1 < len(args) && args[at+1] != "--" {
		at++
	} else if !inline && optional && at+1 < len(args) && !strings.HasPrefix(args[at+1], "-") {
		at++
	}
	if _, variadic := claudeGlobalVariadicOptions[name]; variadic {
		for at+1 < len(args) && !strings.HasPrefix(args[at+1], "-") {
			at++
		}
	}
	return at
}

// UnsupportedNativeService identifies independent services and background starts
// whose lifetime cannot inherit the managed settings/auth overlay. Required and
// optional option values remain opaque; native help is the only general bypass.
func UnsupportedNativeService(args []string) string {
	background := ""
	help := false
	for i := 0; i < len(args); i++ {
		if args[i] == "--" {
			break
		}
		if args[i] == "--help" || args[i] == "-h" {
			help = true
		}
		if args[i] == "--bg" || args[i] == "--background" {
			background = args[i]
		}
		i = NativeOptionValueEnd(args, i)
	}
	// Background preprocessing can run before the ordinary help parser. Root
	// --help documents the flag safely; never treat --bg ... --help as proof
	// that the native process will only show help.
	if background != "" {
		return background
	}
	if help {
		return ""
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if !strings.HasPrefix(arg, "-") {
			switch arg {
			case "daemon", "remote-control", "rc", "remote", "bridge", "sync", "self-hosted-runner", "gateway", "respawn", "attach":
				return arg
			case "agents":
				if !nativeAgentList(args[i+1:]) {
					return arg
				}
			}
			break
		}
		i = NativeOptionValueEnd(args, i)
	}
	return ""
}

// Only this documented agents form lists sessions and exits without a dispatch
// UI. Do not let an unknown option or --json used as another option's value
// authorize a background agent view. The native parser still checks values.
func nativeAgentList(args []string) bool {
	json := false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--json":
			json = true
		case "--all":
		case "--cwd":
			if i+1 >= len(args) || args[i+1] == "--" {
				return false
			}
			i++
		default:
			if !strings.HasPrefix(args[i], "--cwd=") {
				return false
			}
		}
	}
	return json
}

// prepareRuntimeAuthSettings adds a highest-precedence CLI settings overlay
// that neutralizes auth sources loaded later from user/project settings. The
// key, when native API-key mode is selected, lives only in a mode-0600 settings
// file and never in argv. Named files keep this path portable to Windows.
func prepareRuntimeAuthSettingsForCLI(args []string, cli string) ([]string, func(), error) {
	if command := UnsupportedNativeService(args); command != "" {
		return args, func() {}, fmt.Errorf("%s cannot inherit managed authentication/settings; service lifecycle integration is required (native --help remains available)", command)
	}
	raw, err := runtimeAuthSettingsJSONForCLI(args, cli)
	if err != nil {
		return args, func() {}, err
	}
	dir, err := runtimeAuthSettingsDir()
	if err != nil {
		return args, func() {}, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return args, func() {}, fmt.Errorf("create Claude runtime auth settings directory: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return args, func() {}, fmt.Errorf("protect Claude runtime auth settings directory: %w", err)
	}
	cleanupStaleRuntimeAuthSettings(dir, time.Now())
	f, err := os.CreateTemp(dir, "settings-*.json")
	if err != nil {
		return args, func() {}, fmt.Errorf("create Claude runtime auth settings: %w", err)
	}
	name := f.Name()
	if _, err := f.Write(raw); err != nil {
		_ = f.Close()
		_ = os.Remove(name)
		return args, func() {}, fmt.Errorf("write Claude runtime auth settings: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(name)
		return args, func() {}, fmt.Errorf("close Claude runtime auth settings: %w", err)
	}

	cleanup := func() { _ = os.Remove(name) }
	return injectRuntimeAuthSettings(args, name), cleanup, nil
}

func runtimeAuthSettingsDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home for Claude runtime auth settings: %w", err)
	}
	return filepath.Join(home, ".clx", "state", "runtime-auth"), nil
}

func runtimeAuthSettingsJSONForCLI(args []string, cli string) ([]byte, error) {
	env := make(map[string]string, len(runtimeAuthOverrideEnv))
	for _, name := range runtimeAuthOverrideEnv {
		// CLAUDE_CONFIG_DIR has to be stripped from the inherited process so a
		// foreign account cannot win. Do not put it into the temporary settings
		// overlay, though: even the default ~/.claude value makes Claude Code
		// create a separate interactive-state scope and repeat first-run UI.
		// The verified native credential already lives at Claude's default path.
		if name == "CLAUDE_CONFIG_DIR" {
			continue
		}
		env[name] = ""
	}
	for name := range runtimeProviderSelectors {
		env[name] = "0"
	}
	env["ANTHROPIC_BASE_URL"] = officialAnthropicBaseURL
	// Routine native self-update must never add work to a wrapped launch,
	// including an already-current global install or explicit CLI override.
	env["DISABLE_AUTOUPDATER"] = "1"
	if isManagedClaudeCLI(cli) {
		// These are documented native controls. Managed npm prefixes are
		// immutable once published; fleet maintenance owns the next version.
		env["DISABLE_UPDATES"] = "1"
	}
	if mode, key := managedRuntimeAuth(); mode == "api_key" && !isInteractiveAuthLogin(args) {
		env["ANTHROPIC_API_KEY"] = key
	}
	return json.Marshal(map[string]any{
		"apiKeyHelper": "",
		"env":          env,
	})
}

func cleanupStaleRuntimeAuthSettings(dir string, now time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "settings-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil || now.Sub(info.ModTime()) < staleRuntimeAuthSettingsAge {
			continue
		}
		_ = os.Remove(filepath.Join(dir, entry.Name()))
	}
}

func injectRuntimeAuthSettings(args []string, settingsPath string) []string {
	insertAt := len(args)
	if subcommandAt, ok := NativeSubcommandIndex(args); ok {
		insertAt = subcommandAt
	} else if separatorAt := literalSeparatorIndex(args); separatorAt >= 0 {
		insertAt = separatorAt
	}
	out := make([]string, 0, len(args)+2)
	out = append(out, args[:insertAt]...)
	out = append(out, "--settings", settingsPath)
	out = append(out, args[insertAt:]...)
	return out
}

// NativeSubcommandIndex identifies a real root command, respecting option values.
func NativeSubcommandIndex(args []string) (int, bool) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			return 0, false
		}
		if _, subcommand := claudeTopLevelSubcommands[arg]; subcommand {
			return i, true
		}
		if !strings.HasPrefix(arg, "-") {
			return 0, false
		}
		i = NativeOptionValueEnd(args, i)
	}
	return 0, false
}

func literalSeparatorIndex(args []string) int {
	for i, arg := range args {
		if arg == "--" {
			return i
		}
	}
	return -1
}

func isInteractiveAuthLogin(args []string) bool {
	index, ok := NativeSubcommandIndex(args)
	if !ok {
		return false
	}
	switch args[index] {
	case "login":
		return true
	case "auth":
		for _, arg := range args[index+1:] {
			if arg == "login" {
				return true
			}
			if !strings.HasPrefix(arg, "-") {
				return false
			}
		}
	}
	return false
}

func normalizeRuntimeAuthArgs(args []string) ([]string, bool) {
	mode, _ := managedRuntimeAuth()
	if mode != "oauth" {
		return args, false
	}
	out := append([]string(nil), args...)
	changed := false
	for i := 0; i < len(out); i++ {
		arg := out[i]
		if arg == "--" {
			break
		}
		if arg == "--bare" {
			out[i] = "--safe-mode"
			changed = true
			continue
		}
		i = NativeOptionValueEnd(out, i)
	}
	return out, changed
}
