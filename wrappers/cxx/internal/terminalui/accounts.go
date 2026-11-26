package terminalui

import (
	"fmt"
	"strconv"
	"strings"
)

// QuotaAccount is one account of an engine's provider pool. The startup and
// status screens list the pool under the quota bars when an engine has more
// than one account, so the operator sees which account this scope runs on.
type QuotaAccount struct {
	ID       int64
	Label    string
	Short    *int   // 5h used percent; nil when the account has no reading
	Weekly   *int   // weekly used percent; nil when the account has no reading
	Bound    bool   // this scope runs on the account
	Target   bool   // a pending switch moves this scope to the account
	Note     string // short state: "in use", "switching here", "paused", …
	NoteTone Tone   // dim when empty; warn for paused/unverified/at limit
	// Thresholds colour the percentages like the quota bars (0: 80/95).
	WarnAtPct  int
	BlockAtPct int
}

func accountMarker(caps Caps, a QuotaAccount) string {
	ascii := caps.Dumb || !caps.UTF8
	switch {
	case a.Bound && ascii:
		return "*"
	case a.Bound:
		return "●"
	case a.Target && ascii:
		return ">"
	case a.Target:
		return "→"
	}
	return " "
}

func accountUsageText(a QuotaAccount) string {
	if a.Short == nil && a.Weekly == nil {
		return "no reading"
	}
	cell := func(v *int) string {
		if v == nil {
			return "-"
		}
		return fmt.Sprintf("%d%%", clampPct(*v))
	}
	return "5h " + cell(a.Short) + "  7d " + cell(a.Weekly)
}

func accountUsageStyled(caps Caps, a QuotaAccount) string {
	if a.Short == nil && a.Weekly == nil {
		return caps.Palette.Dim + "no reading" + caps.Palette.Reset
	}
	cell := func(v *int) string {
		if v == nil {
			return caps.Palette.Dim + "-" + caps.Palette.Reset
		}
		return tonePalette(caps, classifyPct(*v, a.WarnAtPct, a.BlockAtPct)) + fmt.Sprintf("%d%%", clampPct(*v)) + caps.Palette.Reset
	}
	return caps.Palette.Dim + "5h " + caps.Palette.Reset + cell(a.Short) + caps.Palette.Dim + "  7d " + caps.Palette.Reset + cell(a.Weekly)
}

// formatAccountLines renders the pool as aligned rows within width:
//
//	● #1  email@example.com     5h 12%  7d 87%  in use
//	  #8  other@example.com     no reading      next launch
//
// Every row shares one label width so the usage column lines up. Labels
// shrink before anything else; when the longest note would leave less than
// eight cells for labels, every note moves to an indented continuation line.
func formatAccountLines(caps Caps, rows []QuotaAccount, width int) []string {
	if len(rows) == 0 {
		return nil
	}
	ascii := !caps.UTF8 || caps.Dumb
	clean := func(s string) string {
		if ascii {
			return PlainInline(s)
		}
		return CleanInline(s)
	}
	idWidth, labelWidth, usageWidth, noteWidth := 0, 0, 0, 0
	for _, a := range rows {
		idWidth = max(idWidth, len(strconv.FormatInt(a.ID, 10))+1)
		labelWidth = max(labelWidth, VisibleWidth(clean(a.Label)))
		usageWidth = max(usageWidth, VisibleWidth(accountUsageText(a)))
		noteWidth = max(noteWidth, VisibleWidth(clean(a.Note)))
	}
	headWidth := 2 + idWidth + 2 // marker, space, id, gap
	fixed := headWidth + 2 + usageWidth
	wrapNotes := noteWidth > 0 && width-fixed-2-noteWidth < 8
	room := width - fixed
	if noteWidth > 0 && !wrapNotes {
		room -= 2 + noteWidth
	}
	labelCells := max(1, min(labelWidth, room))
	lines := make([]string, 0, len(rows))
	for _, a := range rows {
		head := accountMarker(caps, a) + " " + caps.Palette.Bold + PadRight("#"+strconv.FormatInt(a.ID, 10), idWidth) + caps.Palette.Reset + "  "
		usage := accountUsageStyled(caps, a) + strings.Repeat(" ", usageWidth-VisibleWidth(accountUsageText(a)))
		note := clean(a.Note)
		tone := a.NoteTone
		if tone == "" {
			tone = ToneDim
		}
		line := head + PadRight(TruncateText(clean(a.Label), labelCells, caps), labelCells) + "  " + usage
		if note != "" && !wrapNotes {
			line += "  " + styleTone(caps, tone, note)
		}
		lines = append(lines, strings.TrimRight(line, " "))
		if note != "" && wrapNotes {
			for _, wrapped := range WrapText(note, max(1, width-headWidth)) {
				lines = append(lines, strings.Repeat(" ", headWidth)+styleTone(caps, tone, wrapped))
			}
		}
	}
	return lines
}

// accountPlainLine is the compact log form of one pool account.
func accountPlainLine(a QuotaAccount) string {
	fields := []string{"account", "id=" + strconv.FormatInt(a.ID, 10)}
	if label := PlainInline(a.Label); label != "" {
		fields = append(fields, "label="+label)
	}
	if a.Short == nil && a.Weekly == nil {
		fields = append(fields, "usage=none")
	} else {
		cell := func(v *int) string {
			if v == nil {
				return "-"
			}
			return fmt.Sprintf("%d%%", clampPct(*v))
		}
		fields = append(fields, "5h="+cell(a.Short), "7d="+cell(a.Weekly))
	}
	if a.Bound {
		fields = append(fields, "bound=true")
	}
	if a.Target {
		fields = append(fields, "switch_target=true")
	}
	if note := PlainInline(a.Note); note != "" {
		fields = append(fields, note)
	}
	return strings.Join(fields, " | ")
}
