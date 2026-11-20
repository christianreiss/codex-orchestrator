// Package claude: installer.go keeps the version comparison the background
// installer (installer_background.go) uses. Claude CLI installs and upgrades
// run only through EnsureClaudeBackground's private versioned npm prefixes.
package claude

import "strings"

// IsDowngrade reports whether installing target would be a downgrade from current.
// Returns false when either version is unparseable.
func IsDowngrade(current, target string) bool {
	if current == "" || current == "unknown" || target == "" || target == "latest" {
		return false
	}
	cv, okC := parseSemverTriple(current)
	tv, okT := parseSemverTriple(target)
	if !okC || !okT {
		return false
	}
	for i := 0; i < 3; i++ {
		if cv[i] > tv[i] {
			return true
		}
		if cv[i] < tv[i] {
			return false
		}
	}
	return false
}

func parseSemverTriple(v string) ([3]int, bool) {
	var out [3]int
	base := strings.TrimPrefix(strings.TrimSpace(v), "v")
	parts := strings.SplitN(base, ".", 3)
	if len(parts) < 3 {
		return out, false
	}
	for i := 0; i < 3; i++ {
		n := 0
		for _, c := range parts[i] {
			if c < '0' || c > '9' {
				break
			}
			n = n*10 + int(c-'0')
		}
		if len(parts[i]) == 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
