package ui

import (
	"fmt"
	"io"
	"strings"
	"time"
)

// ExitFooter is measured post-run state. It deliberately contains the
// upstream exit code and the actual auth-upload outcome, so a failed session
// can never end on a green summary.
type ExitFooter struct {
	RunDuration   time.Duration
	ExitCode      int
	AuthStatus    string
	AuthTone      Tone
	EngineName    string
	EngineVersion string
}

func PrintExitFooter(w io.Writer, caps Caps, prefix string, f ExitFooter) {
	if w == nil {
		return
	}
	prefix = strings.ToUpper(CleanInline(prefix))
	if prefix == "" {
		prefix = "WRAPPER"
	}
	tone := ToneOK
	outcome := fmt.Sprintf("EXIT %d", f.ExitCode)
	if f.ExitCode != 0 {
		tone = ToneFail
	} else if f.AuthTone == ToneFail {
		tone = ToneFail
		outcome += richSeparator(caps) + "AUTH FAILED"
	} else if f.AuthTone == ToneWarn {
		tone = ToneWarn
		outcome += richSeparator(caps) + "ATTENTION"
	}
	auth := strOr(CleanInline(f.AuthStatus), "unchanged")
	engine := CleanInline(f.EngineName)
	version := CleanInline(f.EngineVersion)

	if !caps.IsTTY || caps.Dumb || caps.Columns < minRichColumns {
		fields := []string{
			fmt.Sprintf("exit=%d", f.ExitCode),
			"duration=" + durationPrecise(f.RunDuration),
			"auth=" + auth,
		}
		if engine != "" && version != "" {
			fields = append(fields, engine+"="+version)
		}
		fmt.Fprintln(w, strings.ToLower(prefix)+" | "+strings.Join(fields, " | "))
		return
	}

	c := newCard(w, caps)
	brand := caps.BannerColor() + prefix + caps.Palette.Reset + "  " + caps.Palette.Bold + "SESSION" + caps.Palette.Reset
	c.top()
	c.line(joinSides(brand, styleTone(caps, tone, outcome), c.inner, caps))
	pieces := []string{
		caps.Palette.Dim + "duration" + caps.Palette.Reset + " " + durationPrecise(f.RunDuration),
		styleTone(caps, f.AuthTone, toneSymbol(caps, f.AuthTone, false)) + " " + caps.Palette.Dim + "auth" + caps.Palette.Reset + " " + auth,
	}
	if engine != "" && version != "" {
		pieces = append(pieces, styleTone(caps, ToneOK, toneSymbol(caps, ToneOK, true))+" "+caps.Palette.Dim+engine+caps.Palette.Reset+" "+version)
	}
	for _, line := range packPieces(pieces, c.inner, 4) {
		c.line(line)
	}
	c.bottom()
}

func durationPrecise(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	d = d.Round(time.Second)
	if d < time.Second {
		return "<1s"
	}
	hours := int(d / time.Hour)
	d -= time.Duration(hours) * time.Hour
	minutes := int(d / time.Minute)
	d -= time.Duration(minutes) * time.Minute
	seconds := int(d / time.Second)
	parts := []string{}
	if hours > 0 {
		parts = append(parts, fmt.Sprintf("%dh", hours))
	}
	if minutes > 0 {
		parts = append(parts, fmt.Sprintf("%dm", minutes))
	}
	if seconds > 0 || len(parts) == 0 {
		parts = append(parts, fmt.Sprintf("%ds", seconds))
	}
	return strings.Join(parts, " ")
}
