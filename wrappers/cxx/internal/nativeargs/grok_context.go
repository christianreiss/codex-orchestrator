package nativeargs

import (
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

func optionTable(engine string, args []string, at int) map[string]spec {
	if engine == "kimi" {
		return kimiOptionTable(args, at)
	}
	if engine != "grok" {
		return codex
	}
	path := ""
	initialPrompt := false
	for i := 0; i < at && args[i] != "--"; i++ {
		raw := args[i]
		if raw != "-" && strings.HasPrefix(raw, "-") {
			_, _, end := optionFromTable(engine, args[:at], i, grokTable(path))
			i = end
			continue
		}
		if path == "" {
			if containsWord(grokCommands, raw) {
				path = raw
			} else if initialPrompt {
				break
			} else {
				initialPrompt = true
			}
		} else if containsWord(strings.Fields(grokChildren[path]), raw) {
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
