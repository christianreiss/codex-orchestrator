// Package nativeargs describes argument boundaries shared by managed native
// dispatch, identity and workspace readers. It does not rewrite or validate argv;
// the native parser remains responsible for syntax and value validation.
package nativeargs

import "strings"

type arity uint8

const (
	required arity = iota + 1
	optional
	variadic
)

type spec struct {
	name  string
	arity arity
}

// Sources: Codex rust-v0.163.0 SharedCliOptions/TuiCli and Grok Build 1.0.60
// help/PagerArgs. Comma-delimited vectors take one argv value unless num_args
// explicitly says otherwise. An attached/equal value ends a variadic occurrence.
var codex = map[string]spec{}
var grok = map[string]spec{}

func init() {
	add := func(dst map[string]spec, count arity, names ...string) {
		for _, name := range names {
			dst[name] = spec{names[0], count}
		}
	}
	for _, names := range [][]string{
		{"--config", "-c"},
		{"--model", "-m"},
		{"--profile", "-p"},
		{"--cd", "-C"},
		{"--ask-for-approval", "-a"},
		{"--sandbox", "-s"},
		{"--enable"},
		{"--disable"},
		{"--local-provider"},
		{"--remote"},
		{"--remote-auth-token-env"},
		{"--add-dir"},
		{"--output-schema"},
		{"--output-last-message", "-o"},
		{"--experimental_issuer"},
		{"--experimental_client-id"},
		{"--listen"},
		{"--thread-source"}, {"--cyber-access-program"}, {"--color"}, {"--base"}, {"--commit"}, {"--title"},
	} {
		add(codex, required, names...)
	}
	add(codex, variadic, "--image", "-i")
	add(codex, optional, "--api-key")
	add(grok, 0, "--debug")
	for _, names := range [][]string{
		{"--model", "-m"},
		{"--single", "-p", "--print"},
		{"--rules", "--append-system-prompt"},
		{"--system-prompt-override", "--system-prompt"},
		{"--reasoning-effort", "--effort"},
		{"--allow", "--allowedTools", "--allowed-tools"},
		{"--deny", "--disallowedTools"},
		{"--cwd"},
		{"--debug-file"},
		{"--leader-socket"},
		{"--agent"},
		{"--agents"},
		{"--prompt-file"},
		{"--prompt-json"},
		{"--output-format"},
		{"--json-schema"},
		{"--max-turns"},
		{"--permission-mode"},
		{"--tools"},
		{"--disallowed-tools"},
		{"--session-id", "-s"},
		{"--sandbox"},
		{"--worktree-ref", "--ref"},
		{"--load"},
		{"--compaction-mode"},
		{"--compaction-detail"},
		{"--background-wait-timeout"},
		{"--storage-mode"},
		{"--client-identifier"},
		{"--hunk-tracker-mode"},
		{"--installer"},
		{"--local-workspace-attach"},
		{"--local-workspace-cwd"},
		{"--agent-profile"}, {"--plugin-dir"}, {"--grok-ws-origin"}, {"--grok-ws-url"}, {"--cli-chat-proxy-base-url"}, {"--xai-api-base-url"}, {"--bind"}, {"--secret"}, {"--remote"},
	} {
		add(grok, required, names...)
	}
	add(grok, optional, "--resume", "-r")
	add(grok, optional, "--worktree", "-w")
	add(grok, optional, "--local-workspace")
	// Boolean aliases also need canonical names for headless/security readers.
	for _, names := range [][]string{
		{"--continue", "-c"},
		{"--always-approve", "--yolo", "--dangerously-skip-permissions"},
		{"--version", "-v", "-V"},
		{"--help", "-h"},
	} {
		add(grok, 0, names...)
	}
	add(codex, 0, "--help", "-h")
	add(codex, 0, "--version", "-V")
}

// Option returns canonical name, first value (if any), and the last consumed
// index. Required values are kept opaque even when malformed/flag-shaped, so
// auxiliary readers never reinterpret them as managed control instructions.
func Option(engine string, args []string, at int) (name, value string, end int) {
	end = at
	if at < 0 || at >= len(args) || args[at] == "--" {
		return "", "", end
	}
	table := codex
	if engine == "grok" {
		table = grok
	}
	raw := args[at]
	flag, inline, equal := strings.Cut(raw, "=")
	s, ok := table[flag]
	attached := false
	if !ok && strings.HasPrefix(raw, "-") && !strings.HasPrefix(raw, "--") && len(raw) > 2 {
		// Short booleans may be grouped before an option with a value (-cptext).
		for offset := 1; offset < len(raw); offset++ {
			next, found := table["-"+raw[offset:offset+1]]
			if !found {
				ok = false
				break
			}
			s, ok = next, true
			if next.arity != 0 {
				if offset+1 < len(raw) {
					inline = strings.TrimPrefix(raw[offset+1:], "=")
					attached = true
				}
				break
			}
		}
	}

	if !ok {
		return raw, "", end
	}
	name = s.name
	if equal || attached {
		return name, inline, end
	}
	if s.arity == required && at+1 < len(args) && args[at+1] != "--" {
		return name, args[at+1], at + 1
	}
	if s.arity == optional && at+1 < len(args) && (args[at+1] == "-" || !strings.HasPrefix(args[at+1], "-")) {
		return name, args[at+1], at + 1
	}
	if s.arity == variadic {
		for end+1 < len(args) && (args[end+1] == "-" || !strings.HasPrefix(args[end+1], "-")) {
			end++
		}
		if end > at {
			value = args[at+1]
		}
	}
	return
}
func ValueEnd(engine string, args []string, at int) int {
	_, _, end := Option(engine, args, at)
	return end
}
func Value(engine string, args []string, names ...string) string {
	value := ""
	for i := 0; i < len(args) && args[i] != "--"; i++ {
		name, v, end := Option(engine, args, i)
		for _, want := range names {
			if name == want {
				value = v
			}
		}
		i = end
	}
	return value
}
func Has(engine string, args []string, names ...string) bool {
	for i := 0; i < len(args) && args[i] != "--"; i++ {
		name, _, end := Option(engine, args, i)
		table := codex
		if engine == "grok" {
			table = grok
		}
		candidates := []string{name}
		raw := args[i]
		if strings.HasPrefix(raw, "-") && !strings.HasPrefix(raw, "--") && len(raw) > 2 {
			for offset := 1; offset < len(raw); offset++ {
				s, ok := table["-"+raw[offset:offset+1]]
				if !ok {
					break
				}
				candidates = append(candidates, s.name)
				if s.arity != 0 {
					break
				}
			}
		}
		for _, want := range names {
			canonical, _, _ := Option(engine, []string{want}, 0)
			for _, candidate := range candidates {
				if candidate == canonical {
					return true
				}
			}
		}

		i = end
	}
	return false
}

var codexCommands = strings.Fields("exec e review login logout mcp app-server completion sandbox debug apply a resume fork cloud features help agents archive unarchive delete queue plugin remote-control exec-server migrate-rollouts")

var grokCommands = strings.Fields("agent clone completions cursor-worker dashboard doctor du disk-usage export help inspect leader login logout mcp memory models plugin sessions setup trace update usage version v worktree wrap install upgrade")

// Command returns an unconsumed native command. Both providers accept one
// initial prompt before a subcommand. Unknown Codex positionals retain their
// old fallback so wrapper profile/command classification remains separate.
func Command(engine string, args []string) (string, int) {
	commands := codexCommands
	if engine == "grok" {
		commands = grokCommands
	}
	first := -1
	for i := 0; i < len(args) && args[i] != "--"; i++ {
		raw := args[i]
		if raw != "-" && strings.HasPrefix(raw, "-") {
			i = ValueEnd(engine, args, i)
			continue
		}
		for _, cmd := range commands {
			if cmd == raw {
				return raw, i
			}
		}
		if first >= 0 {
			break
		}
		first = i
	}
	if engine == "codex" && first >= 0 {
		return args[first], first
	}
	return "", -1
}

// UnsupportedService names public entry points whose independent process cannot
// inherit this launch's private auth broker, receiver and teardown lifecycle.
// Wrapper-internal app-server/leader starts occur after these public checks.
func UnsupportedService(engine string, args []string) string {
	command, at := Command(engine, args)
	if engine == "codex" {
		if command == "app-server" || command == "exec-server" || command == "remote-control" || command == "agents" {
			return command
		}
		if Has(engine, args, "--remote") {
			return "--remote"
		}
	} else if engine == "grok" {
		if command == "agent" {
			mode := ""
			for i := at + 1; i < len(args) && args[i] != "--"; i++ {
				if strings.HasPrefix(args[i], "-") {
					i = ValueEnd(engine, args, i)
					continue
				}
				mode = args[i]
				break
			}
			// Grok defaults an absent AgentCmd to Headless. Only an explicit
			// stdio mode selects the stdin/stdout session lifecycle; an opaque
			// option value named stdio must not authorize the headless default.
			if mode == "" {
				return "agent (default headless)"
			}
			if mode == "serve" || mode == "leader" || mode == "headless" {
				return "agent " + mode
			}
		}
		if command == "cursor-worker" {
			return command
		}
		if Has(engine, args, "--leader-socket") {
			return "--leader-socket"
		}
	}
	return ""
}

// CodexSessionCommand also reads an exec/e nested command after its shared
// options. An image value named resume is consumed before this classification.
func CodexSessionCommand(args []string) (string, int) {
	command, at := Command("codex", args)
	if command == "exec" || command == "e" {
		nested, index := Command("codex", args[at+1:])
		if nested == "resume" || nested == "fork" || nested == "review" {
			return nested, at + 1 + index
		}
	}
	return command, at
}

func Resumed(engine string, args []string) bool {
	if engine == "grok" {
		return Has(engine, args, "--resume", "--continue", "--load")
	}
	command, _ := CodexSessionCommand(args)
	return command == "resume"
}
