package agentportal

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml"
)

// AppendIdentityArgs keeps launch identity out of shared managed files. Native
// system/developer additions also apply when a resume has no new user prompt.
func AppendIdentityArgs(engine string, args []string, identity Identity) ([]string, error) {
	if identity.Name == "" {
		return args, nil
	}
	context := identity.Context()
	switch engine {
	case "codex":
		prior, err := codexDeveloperInstructions(args)
		if err != nil {
			return nil, err
		}
		clean, overrides, err := removeStringFlag(engine, args, []string{"-c", "--config"}, "developer_instructions=")
		if err != nil {
			return nil, err
		}
		for _, raw := range overrides {
			tree, err := toml.Load(raw)
			if err != nil {
				return nil, fmt.Errorf("agent identity: invalid developer instructions: %w", err)
			}
			value, ok := tree.Get("developer_instructions").(string)
			if !ok {
				return nil, fmt.Errorf("agent identity: developer instructions must be text")
			}
			prior = value
		}
		encoded, _ := json.Marshal(strings.TrimSpace(prior + "\n\n" + context))
		// -c is accepted by both the root parser and resume/exec subcommands.
		at := codexIdentityOverridePosition(clean)
		out := append([]string{}, clean[:at]...)
		out = append(out, "-c", "developer_instructions="+string(encoded))
		return append(out, clean[at:]...), nil
	case "claude", "grok":
		flag := "--append-system-prompt"
		if engine == "grok" {
			flag = "--rules"
		}
		clean, additions, err := removeStringFlag(engine, args, []string{flag}, "")
		if err != nil {
			return nil, err
		}
		additions = append(additions, context)
		prefix := []string{flag, strings.Join(additions, "\n\n")}
		if engine == "claude" {
			// Claude's default snapshot would otherwise replay the previous launch identity.
			clean, _, err = removeStringFlag(engine, clean, []string{"--system-prompt-snapshot"}, "")
			if err != nil {
				return nil, err
			}
			prefix = append(prefix, "--system-prompt-snapshot", "off")
			var names []string
			clean, names, err = removeStringFlag(engine, clean, []string{"--name", "-n"}, "")
			if err != nil {
				return nil, err
			}
			title := identity.TaskTitle
			if len(names) > 0 {
				title = names[len(names)-1]
			}
			// Leave a resume picker title intact until its exact native ID is bound.
			if title != "" || !hasClaudeResume(clean) {
				prefix = append(prefix, "--name", identity.SessionTitle(title))
			}
		}
		return append(prefix, clean...), nil
	default:
		return nil, fmt.Errorf("agent identity: unsupported engine %q", engine)
	}
}

func codexIdentityOverridePosition(args []string) int {
	for at := 0; at < len(args); at++ {
		arg := args[at]
		if arg == "--" {
			break
		}
		if arg == "exec" || arg == "resume" || arg == "review" {
			if arg == "exec" && at+1 < len(args) && args[at+1] == "resume" {
				return at + 2
			}
			return at + 1
		}
		if identityValueFlag("codex", arg) && at+1 < len(args) {
			at++
		}
	}
	return 0
}

func hasClaudeResume(args []string) bool {
	for _, arg := range args {
		if arg == "--" {
			break
		}
		if arg == "--resume" || arg == "-r" || arg == "--continue" || arg == "-c" || strings.HasPrefix(arg, "--resume=") {
			return true
		}
	}
	return false
}

// Text after -- and values consumed by other options remain byte-for-byte intact.
// Providers also accept options following a positional prompt or resume UUID.
func removeStringFlag(engine string, args, flags []string, valuePrefix string) ([]string, []string, error) {
	out, values := []string{}, []string{}
	options := true
	for at := 0; at < len(args); at++ {
		arg := args[at]
		if arg == "--" {
			options = false
		}
		if options {
			matched := false
			for _, flag := range flags {
				attached := len(flag) == 2 && strings.HasPrefix(arg, flag) && arg != flag
				if arg != flag && !strings.HasPrefix(arg, flag+"=") && !attached {
					continue
				}
				value := strings.TrimPrefix(arg, flag+"=")
				if attached {
					value = strings.TrimPrefix(strings.TrimPrefix(arg, flag), "=")
				}
				separate := arg == flag
				if separate {
					if at+1 >= len(args) {
						return nil, nil, fmt.Errorf("agent identity: %s requires a value", flag)
					}
					value = args[at+1]
				}
				key, _, _ := strings.Cut(value, "=")
				if valuePrefix == "" || strings.TrimSpace(key) == strings.TrimSuffix(valuePrefix, "=") {
					values = append(values, value)
					if separate {
						at++
					}
					matched = true
				}
				break
			}
			if matched {
				continue
			}
		}
		out = append(out, arg)
		// Provider parsers accept options after positional values too. Consume
		// option values so flag-like prompt text is never mistaken for an option.
		if options && identityValueFlag(engine, arg) && at+1 < len(args) && !((arg == "--resume" || arg == "-r") && strings.HasPrefix(args[at+1], "-")) {
			at++
			out = append(out, args[at])
			continue
		}
	}
	return out, values, nil
}

func identityValueFlag(engine, arg string) bool {
	if arg == "-c" {
		return engine == "codex"
	}
	if arg == "-p" {
		return engine == "codex"
	}
	switch arg {
	case "-c", "--config", "-p", "--profile", "-m", "--model", "-C", "--cd", "--add-dir", "-i", "--image", "--output-schema", "-o", "--output-last-message", "--resume", "-r", "--session-id", "--prompt-file", "--output-format", "--system-prompt", "--append-system-prompt", "--rules", "--name", "-n", "--system-prompt-snapshot", "--mcp-config", "--plugin-dir", "--permission-mode", "--allowedTools", "--disallowedTools", "--settings", "--effort", "--agent":
		return true
	}
	return false
}

func codexDeveloperInstructions(args []string) (string, error) {
	home := os.Getenv("CODEX_HOME")
	if home == "" {
		user, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		home = filepath.Join(user, ".codex")
	}
	paths := []string{filepath.Join(home, "config.toml")}
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	profile := ""
	// The cwd/profile flags affect native config selection even for resumed sessions.
	for at := 0; at < len(args); at++ {
		arg := args[at]
		if arg == "--" {
			break
		}
		if (arg == "-C" || arg == "--cd" || arg == "-p" || arg == "--profile") && at+1 < len(args) {
			at++
			if arg == "-p" || arg == "--profile" {
				profile = args[at]
			} else {
				cwd = args[at]
			}
			continue
		}
		if strings.HasPrefix(arg, "--profile=") {
			profile = strings.TrimPrefix(arg, "--profile=")
		}
		if strings.HasPrefix(arg, "--cd=") {
			cwd = strings.TrimPrefix(arg, "--cd=")
		}
		if identityValueFlag("codex", arg) && at+1 < len(args) {
			at++
			continue
		}
		if !strings.HasPrefix(arg, "-") && arg != "exec" && arg != "resume" && arg != "review" {
			break
		}
	}
	cwd, err = filepath.Abs(cwd)
	if err != nil {
		return "", err
	}
	var projects []string
	for dir := cwd; ; dir = filepath.Dir(dir) {
		projects = append(projects, filepath.Join(dir, ".codex", "config.toml"))
		if filepath.Dir(dir) == dir {
			break
		}
	}
	for at := len(projects) - 1; at >= 0; at-- {
		if projects[at] != paths[0] {
			paths = append(paths, projects[at])
		}
	}
	if profile != "" {
		if filepath.Base(profile) != profile || strings.ContainsAny(profile, "/\\") {
			return "", fmt.Errorf("agent identity: invalid profile")
		}
		paths = append(paths, filepath.Join(home, profile+".config.toml"))
	}
	prior := ""
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		tree, err := toml.LoadBytes(raw)
		if err != nil {
			return "", fmt.Errorf("agent identity: read native config: %w", err)
		}
		if value, ok := tree.Get("developer_instructions").(string); ok {
			prior = value
		}
		if profile != "" {
			if value, ok := tree.GetPath([]string{"profiles", profile, "developer_instructions"}).(string); ok {
				prior = value
			}
		}
	}
	return prior, nil
}
