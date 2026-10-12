package launchpad

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

const (
	pathWidth      = 12
	downPathHeight = 3
)

type glyphs struct {
	node, path, pathDim, vertical, down, tee, teeOn, elbow, elbowOn, left, right, sel, selEnd, dot string
	teeLeft, teeLeftOn, elbowLeft, elbowLeftOn                                                     string
}

var (
	unicodeGlyphs = glyphs{node: "●", path: "━", pathDim: "─", vertical: "│", down: "▼", tee: "├─", teeOn: "┣━", elbow: "└─", elbowOn: "┗━", left: "◀", right: "▶", sel: "❰", selEnd: "❱", dot: "·", teeLeft: "─┤", teeLeftOn: "━┫", elbowLeft: "─┘", elbowLeftOn: "━┛"}
	asciiGlyphs   = glyphs{node: "o", path: "=", pathDim: "-", vertical: "|", down: "v", tee: "+-", teeOn: "+=", elbow: "`-", elbowOn: "`=", left: "<", right: ">", sel: "[", selEnd: "]", dot: "-", teeLeft: "-+", teeLeftOn: "=+", elbowLeft: "-'", elbowLeftOn: "='"}
)

func (p *picker) glyphs() glyphs {
	if p.caps.UTF8 && !p.caps.Dumb {
		return unicodeGlyphs
	}
	return asciiGlyphs
}

func (p *picker) paint(color, s string) string {
	if color == "" || s == "" {
		return s
	}
	return color + s + p.caps.Palette.Reset
}

func (p *picker) dim(s string) string  { return p.paint(p.caps.Palette.Dim, s) }
func (p *picker) bold(s string) string { return p.paint(p.caps.Palette.Bold, s) }

func (p *picker) accent(engine string) string {
	switch engine {
	case config.EngineClaude:
		return p.caps.Palette.Violet
	case config.EngineGrok:
		return p.caps.Palette.Green
	}
	return p.caps.Palette.Orange
}

func (p *picker) View() tea.View {
	v := tea.NewView(p.render())
	v.AltScreen = true
	return v
}

// render places everything on one fixed grid of columns: the compass is
// centred, and an engine's model grid hangs off the compass's centre node so
// its path grows out of the hub. Widths are measured on the settled layout
// (all models, full effort strips), so nothing drifts while keys are pressed
// or the reveal animation runs.
func (p *picker) render() string {
	var lines []string
	add := func(indent int, line string) {
		lines = append(lines, strings.Repeat(" ", max(0, indent))+line)
	}
	footer := []string{"", p.footer()}
	if p.notice != "" {
		footer = append(footer, p.paint(p.caps.Palette.Yellow, p.notice))
	}

	if len(p.engines) == 1 {
		width := max(p.gridWidth(), ansi.StringWidth(p.footer()))
		indent := p.centre(width)
		top := p.top(4 + p.visibleRows() + len(footer))
		add(indent, p.title())
		add(indent, p.weeklyNotice(0))
		for _, line := range p.grid() {
			add(indent, line)
		}
		for _, line := range footer {
			add(indent, line)
		}
		return strings.Repeat("\n", top) + strings.Join(lines, "\n")
	}

	hub, nodeCol, hubWidth := p.hub()
	indent := p.centre(max(hubWidth, ansi.StringWidth(p.footer())))
	top := p.top(len(hub) + len(footer))
	if p.stage == stageHub {
		for _, line := range hub {
			add(indent, line)
		}
	} else {
		// Title and blank line stay; the grid replaces the compass from the
		// centre node's row downwards.
		add(indent, hub[0])
		add(0, "")
		anchor := max(2, indent+nodeCol-p.gridNodeCol())
		if p.width > 0 && anchor+p.gridWidth() >= p.width {
			anchor = max(2, p.width-1-p.gridWidth())
		}
		for _, line := range p.grid() {
			add(anchor, line)
		}
	}
	for _, line := range footer {
		add(indent, line)
	}
	return strings.Repeat("\n", top) + strings.Join(lines, "\n")
}

func (p *picker) centre(width int) int {
	if p.width > width {
		return max(2, (p.width-width)/2)
	}
	return 2
}

func (p *picker) top(lines int) int {
	if p.height > lines {
		return max(1, (p.height-lines)/3)
	}
	return 1
}

// gridWidth is the widest settled grid line for the focused engine.
func (p *picker) gridWidth() int {
	e := p.current()
	branch := p.branch
	p.branch = branchFrames
	defer func() { p.branch = branch }()
	strip := 0
	for _, m := range e.Models {
		strip = max(strip, ansi.StringWidth(p.efforts(m, 0)))
	}
	header := 2 + pathWidth + 1 + ansi.StringWidth(p.label(e))
	if p.downward() {
		return max(ansi.StringWidth(p.label(e)), p.gridNodeCol()+4+p.nameWidth(e)+2+strip)
	}
	return max(header, pathWidth+3+4+p.nameWidth(e)+2+strip)
}

func (p *picker) leftward() bool { return len(p.engines) > 1 && p.focus == 0 }
func (p *picker) downward() bool { return len(p.engines) > 1 && p.focus == 2 }

// gridNodeCol places the chosen direction's origin at the compass centre.
func (p *picker) gridNodeCol() int {
	if p.leftward() {
		return p.gridWidth() - 1
	}
	if p.downward() {
		return ansi.StringWidth(p.label(p.current())) / 2
	}
	return 0
}

func (p *picker) nameWidth(e Engine) int {
	width := 0
	for _, m := range e.Models {
		width = max(width, ansi.StringWidth(modelName(m.ID)))
	}
	return width
}

func (p *picker) title() string {
	return p.bold("cxx") + " " + p.dim("launchpad")
}

func (p *picker) label(e Engine) string {
	if e.Disabled != "" {
		return p.dim(e.Label() + " (" + e.Disabled + ")")
	}
	return p.bold(p.paint(p.accent(e.Name), e.Label()))
}

func (p *picker) summary(i int) string {
	e := p.engines[i]
	c := p.cursors[i]
	m := e.Models[c.model]
	parts := []string{modelName(m.ID)}
	if c.effort < len(m.Efforts) {
		parts = append(parts, m.Efforts[c.effort])
	}
	return p.dim(strings.Join(parts, " "+p.glyphs().dot+" "))
}

func modelName(id string) string {
	if id == "" {
		return "configured model"
	}
	return id
}

// hub draws the compass: engine one to the left of the centre, engine two to
// the right, engine three below it. It also returns the centre node's column
// and the block width.
func (p *picker) hub() ([]string, int, int) {
	g := p.glyphs()
	cells := func(i int) (string, string) {
		if i >= len(p.engines) {
			return "", ""
		}
		return p.label(p.engines[i]), p.summary(i)
	}
	leftLabel, leftSub := cells(0)
	rightLabel, rightSub := cells(1)
	side := max(p.sideWidth(0), p.sideWidth(1))
	arm := strings.Repeat(g.pathDim, pathWidth-2)
	centre := g.left + arm + " " + p.bold(g.node) + " " + arm + g.right
	centreWidth := ansi.StringWidth(centre)
	mid := centreWidth / 2
	total := side*2 + 4 + centreWidth
	stem := func(glyph string) string {
		return padRight("", side+2+mid) + p.dim(glyph)
	}

	lines := []string{centerIn(p.title(), total), ""}
	lines = append(lines,
		padLeft(leftLabel, side)+"  "+p.dim(centre)+"  "+rightLabel,
	)
	if len(p.engines) > 2 {
		lines = append(lines, padLeft(leftSub, side)+"  "+padRight("", mid)+p.dim(g.vertical)+padRight("", centreWidth-mid-1)+"  "+rightSub)
		lines = append(lines, padLeft(p.weeklyNotice(0), side)+"  "+padRight("", mid)+p.dim(g.vertical)+padRight("", centreWidth-mid-1)+"  "+p.weeklyNotice(1))
		lines = append(lines, stem(g.vertical), stem(g.down))
		downLabel, downSub := cells(2)
		lines = append(lines, centerIn(downLabel, total), centerIn(downSub, total), centerIn(p.weeklyNotice(2), total))
	} else {
		lines = append(lines, padLeft(leftSub, side)+"  "+padRight("", centreWidth)+"  "+rightSub)
		lines = append(lines, padLeft(p.weeklyNotice(0), side)+"  "+padRight("", centreWidth)+"  "+p.weeklyNotice(1))
	}
	return lines, side + 2 + mid, total
}

// sideWidth is the widest label or summary engine i can ever show, so the
// compass keeps its geometry while the cursor moves.
func (p *picker) sideWidth(i int) int {
	if i >= len(p.engines) {
		return 0
	}
	e := p.engines[i]
	width := max(ansi.StringWidth(p.label(e)), ansi.StringWidth(p.weeklyNotice(i)))
	for _, m := range e.Models {
		effort := 0
		for _, name := range m.Efforts {
			effort = max(effort, ansi.StringWidth(name))
		}
		w := ansi.StringWidth(modelName(m.ID))
		if effort > 0 {
			w += 3 + effort
		}
		width = max(width, w)
	}
	return width
}

// grid draws the chosen engine as a path from the centre that branches into
// its models; the focused model carries the effort strip.
func (p *picker) grid() []string {
	g := p.glyphs()
	e := p.current()
	color := p.accent(e.Name)
	node := p.bold(p.paint(color, g.node))
	if p.downward() {
		col := p.gridNodeCol()
		indent := strings.Repeat(" ", col)
		lines := []string{indent + node}
		grown := min(p.frame, pathFrames) * downPathHeight / pathFrames
		for i := 0; i < downPathHeight; i++ {
			stem := g.vertical
			if i == downPathHeight-1 {
				stem = g.down
			}
			if i < grown {
				lines = append(lines, indent+p.paint(color, stem))
			} else {
				lines = append(lines, indent+p.dim(stem))
			}
		}
		lines = append(lines, p.label(e))
		for _, row := range p.modelRows(false) {
			lines = append(lines, indent+row)
		}
		return lines
	}

	grown := min(p.frame, pathFrames) * pathWidth / pathFrames
	path := p.paint(color, strings.Repeat(g.path, grown)) + p.dim(strings.Repeat(g.pathDim, pathWidth-grown))
	if p.leftward() {
		// Colour grows from the node to the left; labels remain readable.
		path = p.dim(strings.Repeat(g.pathDim, pathWidth-grown)) + p.paint(color, strings.Repeat(g.path, grown))
		width := p.gridWidth()
		lines := []string{padLeft(p.label(e)+" "+path+" "+node, width)}
		for _, row := range p.modelRows(true) {
			lines = append(lines, padLeft(row, width-pathWidth-3))
		}
		return lines
	}
	lines := []string{node + " " + path + " " + p.label(e)}
	indent := strings.Repeat(" ", pathWidth+3)
	for _, row := range p.modelRows(false) {
		lines = append(lines, indent+row)
	}
	return lines
}

// modelRows shares scrolling, reveal timing and selection across directions.
func (p *picker) modelRows(left bool) []string {
	g := p.glyphs()
	e := p.current()
	c := &p.cursors[p.focus]
	color := p.accent(e.Name)
	var lines []string
	rows := p.visibleRows()
	if c.model < c.offset {
		c.offset = c.model
	}
	if c.model >= c.offset+rows {
		c.offset = c.model - rows + 1
	}
	nameWidth := p.nameWidth(e)
	if c.offset > 0 {
		marker := g.vertical + "  " + g.left + " more"
		if left {
			marker = "more " + g.right + "  " + g.vertical
		}
		lines = append(lines, p.dim(marker))
	}
	for i := c.offset; i < min(len(e.Models), c.offset+rows); i++ {
		if p.frame < pathFrames+(i-c.offset) {
			break
		}
		last := i == len(e.Models)-1
		name := padRight(modelName(e.Models[i].ID), nameWidth)
		if left {
			name = padLeft(modelName(e.Models[i].ID), nameWidth)
		}
		if i != c.model {
			branch := g.tee
			if left {
				branch = g.teeLeft
			}
			if last {
				branch = g.elbow
				if left {
					branch = g.elbowLeft
				}
			}
			if left {
				lines = append(lines, p.dim(name)+"  "+p.dim(branch))
			} else {
				lines = append(lines, p.dim(branch)+"  "+p.dim(name))
			}
			continue
		}
		branch := g.teeOn
		if left {
			branch = g.teeLeftOn
		}
		if last {
			branch = g.elbowOn
			if left {
				branch = g.elbowLeftOn
			}
		}
		if left {
			lines = append(lines, p.efforts(e.Models[i], c.effort)+"  "+p.bold(p.paint(color, name))+" "+p.paint(color, g.left+branch))
		} else {
			lines = append(lines, p.paint(color, branch+g.right)+" "+p.bold(p.paint(color, name))+"  "+p.efforts(e.Models[i], c.effort))
		}
	}
	if end := c.offset + rows; end < len(e.Models) {
		marker := g.vertical + "  " + g.down + " more"
		if left {
			marker = "more " + g.down + "  " + g.vertical
		}
		lines = append(lines, p.dim(marker))
	}
	return lines
}

func (p *picker) visibleRows() int {
	rows := 12
	if p.height > 0 {
		// title, blank, path, two "more" markers, blank, footer, notice, margins
		overhead := 10
		if p.downward() {
			overhead += downPathHeight + 1
		}
		rows = max(3, min(rows, p.height-overhead))
	}
	return rows
}

// efforts is the ←→ strip; it grows in from the model over a few frames.
func (p *picker) efforts(m Model, selected int) string {
	g := p.glyphs()
	if len(m.Efforts) == 0 {
		return p.dim("(no effort setting)")
	}
	shown := len(m.Efforts)
	if p.branch < branchFrames {
		shown = max(1, len(m.Efforts)*p.branch/branchFrames)
	}
	color := p.accent(p.current().Name)
	parts := make([]string, 0, shown)
	for i, effort := range m.Efforts[:shown] {
		if i == selected {
			parts = append(parts, p.bold(p.paint(color, g.sel+effort+g.selEnd)))
			continue
		}
		parts = append(parts, p.dim(" "+effort+" "))
	}
	return p.dim(g.left) + " " + strings.Join(parts, " ") + " " + p.dim(g.right)
}

func (p *picker) footer() string {
	var keys []string
	if p.stage == stageHub {
		keys = append(keys, p.slotHint())
		target := p.current()
		keys = append(keys, "enter "+target.Label()+" new", "c continue")
		if target.CanPick() {
			keys = append(keys, "r resume")
		}
		keys = append(keys, "q quit")
	} else {
		keys = append(keys, "↑↓ model", "←→ effort", "enter new", "c continue")
		if p.current().CanPick() {
			keys = append(keys, "r resume")
		}
		if len(p.engines) > 1 {
			keys = append(keys, "esc back")
		} else {
			keys = append(keys, "q quit")
		}
	}
	if !p.caps.UTF8 {
		for i, k := range keys {
			k = strings.ReplaceAll(k, "↑↓", "up/down")
			keys[i] = strings.ReplaceAll(k, "←→", "left/right")
		}
	}
	return p.dim(strings.Join(keys, "   "))
}

func (p *picker) slotHint() string {
	arrows := []string{"←", "→", "↓"}
	if !p.caps.UTF8 {
		arrows = []string{"left", "right", "down"}
	}
	return strings.Join(arrows[:min(len(arrows), len(p.engines))], "/") + " engine"
}

func padLeft(s string, width int) string {
	return strings.Repeat(" ", max(0, width-ansi.StringWidth(s))) + s
}

func padRight(s string, width int) string {
	return s + strings.Repeat(" ", max(0, width-ansi.StringWidth(s)))
}

func centerIn(s string, width int) string {
	return strings.Repeat(" ", max(0, (width-ansi.StringWidth(s))/2)) + s
}
