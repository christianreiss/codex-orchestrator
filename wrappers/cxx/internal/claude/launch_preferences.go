package claude

import "strings"

// LaunchPreferences reads the native session flags from the argv passed to
// Claude. Claude's --model and --effort have no short aliases; unlike Codex,
// -m is not a model flag. Repeated options use the last supplied value.
func LaunchPreferences(args []string) (model, effort string) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		name, value, inline := strings.Cut(arg, "=")
		if name == "--model" || name == "--effort" {
			if !inline {
				if i+1 >= len(args) {
					continue
				}
				i++
				value = args[i]
			}
			if name == "--model" {
				model = strings.TrimSpace(value)
			} else {
				// Native Claude normalizes med and ignores unknown --effort
				// values. Do not advertise a rejected setting in the header.
				effort = NormalizeEffort(value)
			}
			continue
		}
		if inline {
			continue
		}
		// These native options take optional values. A following option is
		// still an option, including bare --resume --model MODEL.
		if arg == "--resume" || arg == "-r" || arg == "--worktree" {
			continue
		}
		if _, required := claudeGlobalOptionsWithValue[arg]; required && i+1 < len(args) {
			i++
		}
	}
	return model, effort
}

// NormalizeEffort mirrors the named levels accepted by native Claude's
// --effort parser. Runtime provider/model caps are decided by Claude itself.
func NormalizeEffort(value string) string {
	switch value = strings.ToLower(strings.TrimSpace(value)); value {
	case "med":
		return "medium"
	case "ultracode":
		return "xhigh"
	case "low", "medium", "high", "xhigh", "max":
		return value
	default:
		return ""
	}
}
