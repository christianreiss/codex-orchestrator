package nativeargs

import (
	"maps"
	"strings"
)

// Generated from the checked-in Kimi Code 2.5.3 help snapshot. Scope matters:
// -y is --yolo at the root and --yes under export/fork/update; --host is
// optional for web/remote but required for vis.
var kimiCommands = strings.Fields("export fork provider session acp web server rc remote login doctor vis install-desktop app migrate import-sessions upgrade update help")
var kimiScopedOptions = map[string]map[string]spec{
	"": {
		"-V":              {"--version", 0},
		"--version":       {"--version", 0},
		"-S":              {"--session", optional},
		"--session":       {"--session", optional},
		"-c":              {"--continue", 0},
		"--continue":      {"--continue", 0},
		"-y":              {"--yolo", 0},
		"--yolo":          {"--yolo", 0},
		"--auto":          {"--auto", 0},
		"-m":              {"--model", required},
		"--model":         {"--model", required},
		"-p":              {"--prompt", required},
		"--prompt":        {"--prompt", required},
		"--output-format": {"--output-format", required},
		"--skills-dir":    {"--skills-dir", required},
		"--agent":         {"--agent", required},
		"--agent-file":    {"--agent-file", required},
		"--add-dir":       {"--add-dir", required},
		"--plan":          {"--plan", 0},
		"-h":              {"--help", 0},
		"--help":          {"--help", 0},
	},
	"export": {
		"-o":                      {"--output", required},
		"--output":                {"--output", required},
		"-y":                      {"--yes", 0},
		"--yes":                   {"--yes", 0},
		"--no-include-global-log": {"--no-include-global-log", 0},
		"-h":                      {"--help", 0},
		"--help":                  {"--help", 0},
	},
	"fork": {
		"--cwd":  {"--cwd", required},
		"-y":     {"--yes", 0},
		"--yes":  {"--yes", 0},
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},
	"provider": {
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},
	"session": {
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},
	"acp": {
		"--login":  {"--login", 0},
		"--region": {"--region", required},
		"-h":       {"--help", 0},
		"--help":   {"--help", 0},
	},
	"web": {
		"--port":                  {"--port", required},
		"--host":                  {"--host", optional},
		"--allowed-host":          {"--allowed-host", variadic},
		"--insecure-no-tls":       {"--insecure-no-tls", 0},
		"--allow-remote-shutdown": {"--allow-remote-shutdown", 0},
		"--dangerous-bypass-auth": {"--dangerous-bypass-auth", 0},
		"--log-level":             {"--log-level", required},
		"--debug-endpoints":       {"--debug-endpoints", 0},
		"--web-title":             {"--web-title", required},
		"--rc":                    {"--rc", 0},
		"--remote-control":        {"--rc", 0},
		"--no-open":               {"--no-open", 0},
		"-h":                      {"--help", 0},
		"--help":                  {"--help", 0},
	},
	"server": {
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},
	"rc": {
		"--port":                  {"--port", required},
		"--host":                  {"--host", optional},
		"--allowed-host":          {"--allowed-host", variadic},
		"--insecure-no-tls":       {"--insecure-no-tls", 0},
		"--allow-remote-shutdown": {"--allow-remote-shutdown", 0},
		"--dangerous-bypass-auth": {"--dangerous-bypass-auth", 0},
		"--log-level":             {"--log-level", required},
		"--debug-endpoints":       {"--debug-endpoints", 0},
		"--web-title":             {"--web-title", required},
		"--no-open":               {"--no-open", 0},
		"-h":                      {"--help", 0},
		"--help":                  {"--help", 0},
	},
	"login": {
		"--region": {"--region", required},
		"-h":       {"--help", 0},
		"--help":   {"--help", 0},
	},
	"doctor": {
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},
	"vis": {
		"--port":    {"--port", required},
		"--host":    {"--host", required},
		"--no-open": {"--no-open", 0},
		"-h":        {"--help", 0},
		"--help":    {"--help", 0},
	},
	"app": {
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},
	"migrate": {
		"--run":         {"--run", 0},
		"--config-only": {"--config-only", 0},
		"-h":            {"--help", 0},
		"--help":        {"--help", 0},
	},
	"upgrade": {
		"-y":     {"--yes", 0},
		"--yes":  {"--yes", 0},
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},
	"provider list": {
		"--json": {"--json", 0},
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},
	"provider add": {
		"--api-key": {"--api-key", required},
		"-h":        {"--help", 0},
		"--help":    {"--help", 0},
	},
	"provider remove": {
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},
	"session list": {
		"--cwd":      {"--cwd", required},
		"--all":      {"--all", 0},
		"--archived": {"--archived", 0},
		"--limit":    {"--limit", required},
		"--json":     {"--json", 0},
		"-h":         {"--help", 0},
		"--help":     {"--help", 0},
	},
	"provider catalog": {
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},

	"doctor config": {
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},

	"doctor tui": {
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},

	"web rotate-token": {
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},

	"server kill": {
		"-h":     {"--help", 0},
		"--help": {"--help", 0},
	},
}
var kimi = kimiScopedOptions[""]
var kimiChildren = map[string]string{"provider": "add remove list catalog help", "session": "list help", "web": "rotate-token", "server": "kill", "doctor": "config tui"}

func kimiTable(path string) map[string]spec {
	table := maps.Clone(kimi)
	if path == "remote" {
		path = "rc"
	}
	if path == "update" {
		path = "upgrade"
	}
	maps.Copy(table, kimiScopedOptions[path])
	return table
}
func kimiOptionTable(args []string, at int) map[string]spec {
	path := ""
	for i := 0; i < at && args[i] != "--"; i++ {
		if strings.HasPrefix(args[i], "-") {
			_, _, i = optionFromTable("kimi", args[:at], i, kimiTable(path))
			continue
		}
		if path == "" {
			if containsWord(kimiCommands, args[i]) {
				path = args[i]
			}
		} else if containsWord(strings.Fields(kimiChildren[path]), args[i]) {
			path += " " + args[i]
		}
	}
	return kimiTable(path)
}
