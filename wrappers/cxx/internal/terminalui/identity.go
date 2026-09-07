package terminalui

import "strings"

func engineCaps(caps Caps, engine string) Caps {
	if strings.EqualFold(engine, "clx") || strings.EqualFold(engine, "claude") {
		caps.Theme = ThemeViolet
	}
	if !caps.IsTTY || caps.Dumb || caps.NoColor {
		caps.Palette = Palette{}
	}
	return caps
}

func normalizeScreen(in ScreenInput) ScreenInput {
	in.Prefix = CleanInline(in.Prefix)
	in.EngineName = CleanInline(in.EngineName)
	if in.Prefix == "" {
		in.Prefix = "cdx"
	}
	if in.EngineName == "" {
		in.EngineName = "codex"
		if in.Prefix == "clx" {
			in.EngineName = "claude"
		}
	}
	return in
}
