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
	"auth":        {},
	"auto-mode":   {},
	"config":      {},
	"doctor":      {},
	"gateway":     {},
	"help":        {},
	"install":     {},
	"login":       {},
	"logout":      {},
	"mcp":         {},
	"plugin":      {},
	"plugins":     {},
	"project":     {},
	"setup-token": {},
	"ultrareview": {},
	"update":      {},
	"upgrade":     {},
}

var claudeGlobalOptionsWithValue = map[string]struct{}{
	"--add-dir":              {},
	"--agent":                {},
	"--agents":               {},
	"--allowed-tools":        {},
	"--allowedTools":         {},
	"--append-system-prompt": {},
	"--betas":                {},
	"--debug-file":           {},
	"--disallowed-tools":     {},
	"--disallowedTools":      {},
	"--effort":               {},
	"--fallback-model":       {},
	"--file":                 {},
	"--input-format":         {},
	"--json-schema":          {},
	"--max-budget-usd":       {},
	"--mcp-config":           {},
	"--model":                {},
	"--name":                 {},
	"--output-format":        {},
	"--permission-mode":      {},
	"--plugin-dir":           {},
	"--plugin-url":           {},
	"--resume":               {},
	"--session-id":           {},
	"--setting-sources":      {},
	"--settings":             {},
	"--system-prompt":        {},
	"--tools":                {},
	"--worktree":             {},
	"-n":                     {},
	"-r":                     {},
}

// prepareRuntimeAuthSettings adds a highest-precedence CLI settings overlay
// that neutralizes auth sources loaded later from user/project settings. The
// key, when native API-key mode is selected, lives only in a mode-0600 settings
// file and never in argv. Named files keep this path portable to Windows.
func prepareRuntimeAuthSettings(args []string) ([]string, func(), error) {
	raw, err := runtimeAuthSettingsJSON(args)
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

func runtimeAuthSettingsJSON(args []string) ([]byte, error) {
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
	if subcommandAt, ok := claudeSubcommandIndex(args); ok {
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

func claudeSubcommandIndex(args []string) (int, bool) {
	skipValue := false
	for i, arg := range args {
		if skipValue {
			skipValue = false
			continue
		}
		if arg == "--" {
			return 0, false
		}
		if _, subcommand := claudeTopLevelSubcommands[arg]; subcommand {
			return i, true
		}
		if strings.HasPrefix(arg, "--") && strings.Contains(arg, "=") {
			continue
		}
		if _, takesValue := claudeGlobalOptionsWithValue[arg]; takesValue {
			skipValue = true
			continue
		}
		if !strings.HasPrefix(arg, "-") {
			// The first non-option token is a root-command prompt, not a later
			// subcommand. CLI settings can be appended after it.
			return 0, false
		}
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
	index, ok := claudeSubcommandIndex(args)
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
	skipValue := false
	for i, arg := range out {
		if skipValue {
			skipValue = false
			continue
		}
		if arg == "--" {
			break
		}
		if arg == "--bare" {
			out[i] = "--safe-mode"
			changed = true
			continue
		}
		if strings.HasPrefix(arg, "--") && strings.Contains(arg, "=") {
			continue
		}
		if _, takesValue := claudeGlobalOptionsWithValue[arg]; takesValue {
			skipValue = true
		}
	}
	return out, changed
}
