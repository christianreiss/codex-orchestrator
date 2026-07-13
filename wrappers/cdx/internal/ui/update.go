package ui

import "strings"

// UpdateProgress renders the start of a wrapper or engine update. It follows
// the same TTY, TERM, and NO_COLOR rules as the rest of the wrapper UI.
func UpdateProgress(caps Caps, engine, component, current, target string) string {
	current = normalizedVersion(current)
	target = normalizedVersion(target)
	status := updateText(caps, "installing…", "installing...")
	if current != "" && target != "" {
		status = updateText(caps, "updating…", "updating...")
	}
	return formatUpdate(caps, caps.Palette.Cyan+caps.Palette.Bold, updateGlyph(caps, "↻", "~"), engine, component, updateVersion(caps, current, target), status)
}

// UpdateComplete renders a successful update. restarting distinguishes a
// wrapper hand-off from a completed engine CLI update.
func UpdateComplete(caps Caps, engine, component, version string, restarting bool) string {
	status := "updated"
	if restarting {
		status += updateText(caps, ", restarting…", ", restarting...")
	}
	return formatUpdate(caps, caps.Palette.Green+caps.Palette.Bold, updateGlyph(caps, "✓", "OK"), engine, component, normalizedVersion(version), status)
}

// UpdateFailure renders an update failure without leaking ANSI escapes into
// non-interactive output.
func UpdateFailure(caps Caps, engine, component, version string, err error) string {
	status := "update skipped"
	if err != nil {
		status += ": " + err.Error()
	}
	return formatUpdate(caps, caps.Palette.Red+caps.Palette.Bold, updateGlyph(caps, "✗", "FAIL"), engine, component, normalizedVersion(version), status)
}

func formatUpdate(caps Caps, color, glyph, engine, component, version, status string) string {
	reset := caps.Palette.Reset
	dim := caps.Palette.Dim
	parts := []string{
		color + glyph + reset,
		caps.Palette.Bold + engine + reset,
		dim + component + reset,
	}
	if version != "" {
		parts = append(parts, caps.Palette.Bold+version+reset)
	}
	parts = append(parts, color+status+reset)
	return strings.Join(parts, dim+" · "+reset)
}

func updateVersion(caps Caps, current, target string) string {
	if current != "" && target != "" {
		return current + dimmedArrow(caps) + target
	}
	if target != "" {
		return target
	}
	return current
}

func dimmedArrow(caps Caps) string {
	if caps.Dumb || !caps.UTF8 {
		return caps.Palette.Dim + " -> " + caps.Palette.Reset
	}
	return caps.Palette.Dim + " → " + caps.Palette.Reset
}

func updateGlyph(caps Caps, utf8, ascii string) string {
	if caps.Dumb || !caps.UTF8 {
		return ascii
	}
	return utf8
}

func updateText(caps Caps, utf8, ascii string) string {
	if caps.Dumb || !caps.UTF8 {
		return ascii
	}
	return utf8
}

func normalizedVersion(version string) string {
	version = strings.TrimSpace(version)
	if version == "unknown" {
		return ""
	}
	return version
}
