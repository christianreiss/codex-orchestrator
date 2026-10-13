package launchpad

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// Placements are composed in terminal cells, never byte offsets. Every piece is
// clipped to its allocated rectangle before composition; ANSI remains intact.
type placement struct {
	x    int
	text string
}
type scene [][]placement

func (s scene) put(x, y int, text string) {
	if y >= 0 && y < len(s) {
		s[y] = append(s[y], placement{x, text})
	}
}
func (s scene) panel(x, y int, lines []string) {
	for i, line := range lines {
		s.put(x, y+i, line)
	}
}
func (s scene) lines(width int) []string {
	out := make([]string, len(s))
	for y, pieces := range s {
		sort.SliceStable(pieces, func(i, j int) bool { return pieces[i].x < pieces[j].x })
		for _, piece := range pieces {
			col := ansi.StringWidth(out[y])
			if piece.x < col || piece.x >= width {
				continue
			}
			out[y] += strings.Repeat(" ", piece.x-col) + ansi.Truncate(piece.text, width-piece.x, "")
		}
	}
	return out
}

func (p *picker) richCards() bool { return p.caps.UTF8 && !p.caps.Dumb }
func (p *picker) fit(text string, width int) string {
	tail := "…"
	if !p.richCards() {
		tail = "~"
	}
	return ansi.Truncate(text, max(0, width), tail)
}
func (p *picker) surface(text string, active bool) string {
	pal := p.caps.Palette
	bg := pal.Surface
	if active {
		bg = pal.SurfaceActive
	}
	if bg == "" {
		return text
	}
	// Foreground spans reset themselves; restore the panel surface after them.
	return bg + pal.Text + strings.ReplaceAll(text, pal.Reset, pal.Reset+bg+pal.Text) + pal.Reset
}

func (p *picker) renderObsidian() string {
	width, height := max(1, p.width-2), max(1, p.height)
	if width < 74 || height < 23 || !p.richCards() {
		return p.renderCompact(width, height)
	}
	width = min(132, width)
	bodyHeight := min(22, height-8)
	body := make(scene, bodyHeight)
	mid := width / 2
	panelWidth := mid - 7
	nodeRow := 1
	// A fixed origin is shared by hub, all three branches and every frame.
	body.put(mid, nodeRow, p.bold(p.paint(p.accent(p.current().Name), "●")))
	body.put(mid-1, 0, p.dim("cxx"))
	if p.stage == stageHub {
		p.placeCard(body, 0, 0, p.engineCard(0, panelWidth))
		if len(p.engines) > 1 {
			p.placeCard(body, mid+7, 0, p.engineCard(1, panelWidth))
		}
		p.path(body, panelWidth, mid, nodeRow, false, 0)
		if len(p.engines) > 1 {
			p.path(body, mid+1, mid+7, nodeRow, true, 1)
		}
		if len(p.engines) > 2 {
			for y := 2; y < 6; y++ {
				body.put(mid, y, p.dim("│"))
			}
			p.placeCard(body, mid-panelWidth/2, 6, p.engineCard(2, panelWidth))
		}
	} else {
		x, y, w := 0, 0, panelWidth
		switch {
		case len(p.engines) == 1:
			w = min(76, width)
			x = (width - w) / 2
			body = make(scene, bodyHeight)
		case p.downward():
			w = min(76, width)
			x = (width - w) / 2
			y = 4
			for r := 2; r < y; r++ {
				color := p.caps.Palette.Border
				if (r-2)*6 < (y-2)*p.transition {
					color = p.accent(p.current().Name)
				}
				body.put(mid, r, p.paint(color, "│"))
			}
		case p.leftward():
			p.path(body, panelWidth, mid, nodeRow, false, p.focus)
		default:
			x = mid + 7
			p.path(body, mid+1, x, nodeRow, true, p.focus)
		}
		p.placeCard(body, x, y, p.modelCard(w, len(body)-y-1))
	}
	indent := max(0, (p.width-width)/2)
	lines := []string{centerIn(p.bold("cxx")+p.dim("  /  L A U N C H P A D"), width), ""}
	lines = append(lines, body.lines(width)...)
	lines = append(lines, p.footerLines(width)...)
	for i, line := range lines {
		lines[i] = strings.Repeat(" ", indent) + p.fit(line, width)
	}
	top := max(0, (height-len(lines))/3)
	lines = append(make([]string, top), lines...)
	for len(lines) < height {
		lines = append(lines, "")
	}
	base := p.caps.Palette.Canvas
	if base != "" {
		base += p.caps.Palette.Text
		reset := p.caps.Palette.Reset
		for i, line := range lines {
			lines[i] = base + strings.ReplaceAll(padRight(line, p.width), reset, reset+base) + reset
		}
	}
	return strings.Join(lines, "\n")
}

func (p *picker) placeCard(body scene, x, y int, lines []string) {
	body.panel(x, y, lines)
	if p.caps.Palette.Shadow != "" && len(lines) > 0 {
		body.put(x+1, y+len(lines), p.paint(p.caps.Palette.Shadow, strings.Repeat("▀", ansi.StringWidth(lines[0])-1)))
	}
}

func (p *picker) path(s scene, from, to, y int, right bool, engine int) {
	n := to - from
	if n <= 0 {
		return
	}
	active := engine == p.focus
	var b strings.Builder
	for i := 0; i < n; i++ {
		color := p.caps.Palette.Border
		step := i
		if !right {
			step = n - 1 - i
		}
		if active && (p.stage == stageHub || step*6 < n*p.transition) {
			color = p.accent(p.engines[engine].Name)
		}
		glyph := "─"
		if active && p.transition < 6 && step == n*p.transition/6 {
			glyph = "━"
		}
		b.WriteString(p.paint(color, glyph))
	}
	s.put(from, y, b.String())
}

func (p *picker) engineCard(i, width int) []string {
	e := p.engines[i]
	selected := i == p.focus
	marker := "  "
	if selected {
		marker = "◆ "
	}
	heading := marker + e.Label()
	arrow := []string{"←", "→", "↓"}[i]
	heading = p.paint(p.accent(e.Name), p.bold(heading)) + "  " + p.dim(arrow)
	if e.Disabled != "" {
		heading = p.dim(marker + e.Label() + "  " + arrow)
	}
	detail := p.summary(i)
	if e.Disabled != "" {
		detail = p.paint(p.caps.Palette.Yellow, e.Disabled)
	}
	return p.card([]string{heading, detail, p.quotaBar(i, width-4)}, width, selected, e.Name)
}

func (p *picker) card(content []string, width int, active bool, engine string) []string {
	inner := max(1, width-4)
	color := p.caps.Palette.Border
	if active {
		color = p.accent(engine)
	}
	// One low-contrast highlight traverses only the active top edge. No layout
	// changes or text blinking; reduced motion renders a stationary light edge.
	var edge strings.Builder
	for i := 0; i < width-2; i++ {
		c := color
		if active && p.animate && p.transition >= 6 && i == (p.glow/3)%(width-2) {
			c = p.caps.Palette.Text
		}
		step := i
		if p.stage == stageGrid && p.leftward() {
			step = width - 3 - i
		}
		if active && p.transition < 6 && step*6 > (width-2)*p.transition {
			c = p.caps.Palette.Border
		}
		edge.WriteString(p.paint(c, "─"))
	}
	lines := []string{p.paint(color, "╭") + edge.String() + p.paint(color, "╮")}
	for i, line := range content {
		text := padRight(p.fit(line, inner), inner)
		edgeColor := color
		if active && p.transition < 6 && i*6 > len(content)*p.transition {
			edgeColor = p.caps.Palette.Border
		}
		lines = append(lines, p.paint(edgeColor, "│")+p.surface(" "+text+" ", false)+p.paint(edgeColor, "│"))
	}
	lines = append(lines, p.paint(color, "╰"+strings.Repeat("─", width-2)+"╯"))
	return lines
}

func (p *picker) quotaBar(i, width int) string {
	e := p.engines[i]
	if e.Name == config.EngineGrok {
		return p.dim("reasoning engine")
	}
	text, fresh := weeklyText(e.Weekly, time.Now())
	if text == "week --" {
		return p.dim(text)
	}
	color := p.accent(e.Name)
	if !fresh {
		color = p.caps.Palette.Dim
	} else if *e.Weekly.Used >= 100 {
		color = p.caps.Palette.Red
	} else if *e.Weekly.Used >= 85 {
		color = p.caps.Palette.Yellow
	}
	n := min(12, max(0, width-ansi.StringWidth(text)-2))
	if n < 3 {
		return p.paint(color, text)
	}
	fill := n * (*e.Weekly.Used) / 100
	return p.paint(color, strings.Repeat("━", fill)) + p.dim(strings.Repeat("─", n-fill)) + "  " + p.paint(color, text)
}

func (p *picker) modelCard(width, height int) []string {
	e := p.current()
	c := &p.cursors[p.focus]
	rows := max(1, height-9)
	rows = min(rows, len(e.Models))
	p.scroll(rows)
	content := []string{p.bold(p.paint(p.accent(e.Name), e.Label())) + p.dim("  /  MODEL"), p.quotaBar(p.focus, width-4), p.dim(strings.Repeat("─", width-4))}
	for i := c.offset; i < min(len(e.Models), c.offset+rows); i++ {
		name := p.fit(modelName(e.Models[i].ID), width-8)
		line := "  " + name
		if i == c.model {
			line = p.surface(p.bold(p.paint(p.accent(e.Name), "▸ "+padRight(name, width-8))), true)
		} else {
			line = p.dim(line)
		}
		content = append(content, line)
	}
	position := fmt.Sprintf("%d / %d", c.model+1, len(e.Models))
	if len(e.Models) > rows {
		position += "  ↑↓ more"
	}
	content = append(content, p.dim(position), p.dim("REASONING"), p.effortSegments(width-4), "")
	return p.card(content, width, true, e.Name)
}

func (p *picker) scroll(rows int) {
	c := &p.cursors[p.focus]
	if c.model < c.offset {
		c.offset = c.model
	}
	if c.model >= c.offset+rows {
		c.offset = c.model - rows + 1
	}
	c.offset = max(0, min(c.offset, max(0, len(p.current().Models)-rows)))
}

// Window the effort strip around the selected segment. The selected value is
// always rendered, even while transitioning or when the full strip won't fit.
func (p *picker) effortSegments(width int) string {
	c := p.cursors[p.focus]
	efforts := p.current().Models[c.model].Efforts
	if len(efforts) == 0 {
		return p.dim("no effort setting")
	}
	segment := func(i int) string {
		if i == c.effort {
			return p.surface(p.bold(p.paint(p.accent(p.current().Name), "["+efforts[i]+"]")), true)
		}
		return p.dim(" " + efforts[i] + " ")
	}
	start, end := c.effort, c.effort+1
	out := segment(c.effort)
	for {
		changed := false
		if start > 0 && ansi.StringWidth(out)+len(efforts[start-1])+3 <= width-4 {
			start--
			out = segment(start) + " " + out
			changed = true
		}
		if end < len(efforts) && ansi.StringWidth(out)+len(efforts[end])+3 <= width-4 {
			out += " " + segment(end)
			end++
			changed = true
		}
		if !changed {
			break
		}
	}
	left, right := "  ", "  "
	if start > 0 {
		left = "< "
	}
	if end < len(efforts) {
		right = " >"
	}
	return p.fit(left+out+right, width)
}

func (p *picker) footerLines(width int) []string {
	key := func(k, label string) string { return p.surface(" "+k+" ", true) + " " + p.dim(label) }
	actions := key("enter", "new") + "   " + key("c", "continue")
	if p.current().CanPick() {
		actions += "   " + key("r", "resume")
	}
	actions += "   " + key("q", "quit")
	nav := p.slotHint()
	if p.stage == stageGrid {
		nav = "↑↓ model   ←→ effort"
		if !p.richCards() {
			nav = "up/down model  left/right effort"
		}
		if len(p.engines) > 1 {
			nav += "   esc back"
		}
	}
	selected := p.current().Label() + " / " + ansiStripText(p.summary(p.focus))
	return []string{"", p.fit(p.paint(p.accent(p.current().Name), selected), width), p.fit(actions, width), p.fit(p.dim(nav), width), p.fit(p.paint(p.caps.Palette.Yellow, p.notice), width), ""}
}
func ansiStripText(s string) string { return ansi.Strip(s) }

// Plain/minimal and very small terminals share a compact viewport. Navigation
// and notices get space before decorative content; no off-screen selected row.
func (p *picker) renderCompact(width, height int) string {
	if height < 8 {
		c := p.cursors[p.focus]
		m := p.current().Models[c.model]
		line := p.current().Label() + " " + modelName(m.ID)
		if c.effort < len(m.Efforts) {
			line += " [" + m.Efforts[c.effort] + "]"
		}
		lines := []string{p.fit(line, width), p.fit("enter new  c continue  q quit", width), p.fit(p.notice, width)}
		return strings.Join(lines[:min(height, len(lines))], "\n")
	}
	lines := []string{p.bold("cxx") + p.dim(" / launchpad")}
	available := max(1, height-7)
	if p.stage == stageHub {
		for i, e := range p.engines {
			marker := "  "
			if i == p.focus {
				marker = "> "
			}
			direction := []string{"left", "right", "down"}[i]
			line := marker + e.Label() + " (" + direction + ")  " + p.summary(i)
			if e.Disabled != "" {
				line = marker + e.Label() + " (" + direction + ") " + e.Disabled
			}
			lines = append(lines, p.fit(line, width))
			if available >= len(p.engines)*2 && e.Name != config.EngineGrok {
				lines = append(lines, p.fit("  "+p.weeklyNotice(i), width))
			}
		}
	} else {
		lines = append(lines, p.fit(p.label(p.current())+"  "+p.weeklyNotice(p.focus), width))
		rows := max(1, min(len(p.current().Models), available-3))
		p.scroll(rows)
		c := p.cursors[p.focus]
		for i := c.offset; i < min(len(p.current().Models), c.offset+rows); i++ {
			marker := "  "
			if i == c.model {
				marker = "> "
			}
			lines = append(lines, p.fit(marker+modelName(p.current().Models[i].ID), width))
		}
		position := fmt.Sprintf("%d / %d", c.model+1, len(p.current().Models))
		if len(p.current().Models) > rows {
			position += "  more"
		}
		lines = append(lines, p.effortSegments(width), p.dim(position))
	}
	footer := p.footerLines(width)
	// Space belongs to the content, not a fixed vertical offset on small TTYs.
	lines = append(lines, footer[1:5]...)
	for i := range lines {
		lines[i] = p.fit(lines[i], width)
	}
	return strings.Join(lines[:min(height, len(lines))], "\n")
}
