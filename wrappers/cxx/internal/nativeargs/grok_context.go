package nativeargs

import (
	"errors"
	"maps"
	"strings"
)

// Grok reuses short names, and even a long option's arity can change below a
// subcommand. These overrides describe native 1.0.70 (unchanged in 1.0.77),
// never wrapper grammar.
var grokScopedOptions = map[string]map[string]spec{
	"mcp add": {
		"--scope": {"--scope", required}, "-s": {"--scope", required},
	},
	"mcp remove": {
		"--scope": {"--scope", required}, "-s": {"--scope", required},
	},
	"worktree create":          {"--ref": {"--ref", required}},
	"worker controller":        {"--pool": {"--pool", required}},
	"leader worker controller": {"--pool": {"--pool", required}},
	"update":                   {"--version": {"--version", required}},
	"export":                   {"--clipboard": {"--clipboard", 0}, "-c": {"--clipboard", 0}},
}

var grokChildren = map[string]string{
	"agent":              "stdio serve leader headless",
	"worker":             "start status stop controller",
	"leader":             "worker list info kill",
	"leader worker":      "start status stop controller",
	"worktree":           "create list rm gc redirect show detach salvage clean-artifacts db",
	"worktree redirect":  "add del list fixup unmount",
	"mcp":                "add remove get list",
	"sessions":           "list search delete",
	"plugin":             "install uninstall list marketplace",
	"plugin marketplace": "add remove list",
}

func grokTable(path string) map[string]spec {
	overrides := grokScopedOptions[path]
	if len(overrides) == 0 {
		return grok
	}
	table := maps.Clone(grok)
	maps.Copy(table, overrides)
	return table
}

type grokRootArgs struct {
	command           string
	at, prompt        int
	missingPrintValue bool
}

// A root option ends a positional run. From 1.0.91, once the first word
// in a run is a prompt, all adjacent words remain prompt text.
func grokRoot(args []string, variadic bool) grokRootArgs {
	root := grokRootArgs{at: -1, prompt: -1}
	inPrompt := false
	for i := 0; i < len(args) && args[i] != "--"; i++ {
		raw := args[i]
		if raw != "-" && strings.HasPrefix(raw, "-") {
			name, value, end := optionFromTable("grok", args, i, grok)
			if name == "--single" && end == i && value == "" && !strings.Contains(raw, "=") {
				root.missingPrintValue = true
			}
			inPrompt = false
			i = end
			continue
		}
		if variadic && inPrompt {
			continue
		}
		if containsWord(grokCommands, raw) {
			root.command, root.at = raw, i
			break
		}
		if !variadic && root.prompt >= 0 {
			break
		}
		if root.prompt < 0 {
			root.prompt = i
		}
		inPrompt = true
	}
	return root
}

// GrokLegacyArgs returns a version-sensitive decision only when the two
// grammars could dispatch differently. After a native command is selected,
// its initial interactive prompt has no effect on that command.
func GrokLegacyArgs(args []string) (legacy []string, err error, differs bool) {
	old, current := grokRoot(args, false), grokRoot(args, true)
	if old.missingPrintValue && (old.at >= 0 || current.at >= 0) {
		return nil, errors.New("this Grok version requires a prompt value for -p/--single/--print"), true
	}
	if old.at == current.at {
		return args, nil, false
	}
	if old.at < 0 {
		return nil, errors.New("this Grok version accepts only one initial prompt; quote the prompt words or put the subcommand first"), true
	}
	adjusted := append([]string(nil), args[:old.prompt]...)
	return append(adjusted, args[old.prompt+1:]...), nil, true
}

func optionTable(engine string, args []string, at int) map[string]spec {
	if engine == "kimi" {
		return kimiOptionTable(args, at)
	}
	if engine != "grok" {
		return codex
	}
	root := grokRoot(args[:at], true)
	path := root.command
	if path == "" {
		return grok
	}
	for i := root.at + 1; i < at && args[i] != "--"; i++ {
		raw := args[i]
		if raw != "-" && strings.HasPrefix(raw, "-") {
			_, _, end := optionFromTable(engine, args[:at], i, grokTable(path))
			i = end
			continue
		}
		if containsWord(strings.Fields(grokChildren[path]), raw) {
			path += " " + raw
		}
	}
	return grokTable(path)
}

func containsWord(words []string, word string) bool {
	for _, candidate := range words {
		if candidate == word {
			return true
		}
	}
	return false
}
