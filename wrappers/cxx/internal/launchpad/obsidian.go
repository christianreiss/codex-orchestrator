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
func (p *picker) ellipsis() string {
	if p.richCards() {
		return "…"
	}
	return "..."
}
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

// pair is "model · effort", the way every screen names a selection.
func (p *picker) pair(model, effort string) string {
	if effort == "" {
		return modelName(model)
	}
	return modelName(model) + " " + p.glyphs().dot + " " + effort
}

// joinSides puts right at the far edge of width when both fit, else drops it.
func joinSides(left, right string, width int) string {
	gap := width - ansi.StringWidth(left) - ansi.StringWidth(right)
	if right == "" || gap < 2 {
		return left
	}
	return left + strings.Repeat(" ", gap) + right
}

func (p *picker) renderObsidian() string {
	width, height := max(1, p.width-2), max(1, p.height)
	if width < 74 || height < 23 || !p.richCards() {
		return p.renderCompact(width, height)
	}
	width = min(132, width)
	bodyHeight := min(22, height-2-footerRows)
	body := make(scene, bodyHeight)
	mid := width / 2
	panelWidth := mid - 7
	nodeRow := 1
	// A fixed origin is shared by hub, all three branches and every frame.
	body.put(mid, nodeRow, p.bold(p.paint(p.accent(p.current().Name), "●")))
	if p.stage == stageHub {
		p.hubCards(body, mid, panelWidth, nodeRow)
	} else {
		x, y, w := 0, 0, panelWidth
		switch {
		case len(p.engines) == 1:
			w = min(76, width)
			x = (width - w) / 2
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
	footer := p.footerLines(width) // after the cards: they decide p.legend
	indent := max(0, (p.width-width)/2)
	lines := []string{centerIn(p.bold("cxx")+p.dim("  /  L A U N C H P A D"), width), ""}
	// The footer follows the content instead of sitting below empty body rows.
	// The total stays fixed, so the title and origin never move.
	rows := body.lines(width)
	used := len(rows)
	for used > 0 && strings.TrimSpace(ansi.Strip(rows[used-1])) == "" {
		used--
	}
	lines = append(lines, rows[:used]...)
	for _, line := range footer {
		lines = append(lines, centerIn(line, width))
	}
	for len(lines) < 2+bodyHeight+len(footer) {
		lines = append(lines, "")
	}
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

// hubCards lays out the compass: two cards beside the origin and, for three
// or four engines, a second row below it joined by a stem.
func (p *picker) hubCards(body scene, mid, panelWidth, nodeRow int) {
	cards := make([][]string, len(p.engines))
	for i := range p.engines {
		cards[i] = p.engineCard(i, panelWidth)
	}
	p.placeCard(body, 0, 0, cards[0])
	p.path(body, panelWidth, mid, nodeRow, false, 0)
	if len(p.engines) > 1 {
		p.placeCard(body, mid+7, 0, cards[1])
		p.path(body, mid+1, mid+7, nodeRow, true, 1)
	}
	if len(p.engines) < 3 {
		return
	}
	row := len(cards[0]) + 1 // below the first row's shadow
	stem := p.caps.Palette.Border
	if p.focus >= 2 {
		stem = p.accent(p.current().Name)
	}
	end := row
	if len(p.engines) > 3 {
		end = row + 1
	}
	for y := nodeRow + 1; y < end; y++ {
		body.put(mid, y, p.paint(stem, "│"))
	}
	if len(p.engines) == 3 {
		p.placeCard(body, mid-panelWidth/2, row, cards[2])
		return
	}
	// Four engines: the stem meets a second crossbar on the lower headings.
	p.placeCard(body, 0, row, cards[2])
	p.placeCard(body, mid+7, row, cards[3])
	p.path(body, panelWidth, mid, row+1, false, 2)
	body.put(mid, row+1, p.paint(stem, "┴"))
	p.path(body, mid+1, mid+7, row+1, true, 3)
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

// engineCard is one compass card: engine, the choice enter would launch,
// weekly usage and, once known, the engine's fleet default.
func (p *picker) engineCard(i, width int) []string {
	e := p.engines[i]
	inner := width - 4
	selected := i == p.focus
	marker := "  "
	if selected {
		marker = "◆ "
	}
	arrow := p.dim([]string{"←", "→", "↓", "↑"}[i])
	heading := p.paint(p.accent(e.Name), p.bold(marker+e.Label())) + "  " + arrow
	detail := ansi.Strip(p.summary(i))
	if !selected {
		detail = p.dim(detail)
	}
	quota := p.quotaBar(i, inner)
	if e.Disabled != "" {
		heading = p.dim(marker+e.Label()) + "  " + arrow
		detail = p.paint(p.caps.Palette.Yellow, e.Disabled)
		quota = ""
	}
	content := []string{heading, detail, quota}
	if p.defaults != nil {
		// Reserved even while unknown, so every card keeps one height.
		content = append(content, p.hubDefault(i, inner, true))
	}
	return p.card(content, width, selected, e.Name)
}

// hubDefault names engine i's fleet default on its compass card. When the
// card's choice already is that default, the line only says so.
func (p *picker) hubDefault(i, width int, narrow bool) string {
	d := p.fleetValue(i)
	e := p.engines[i]
	if d == nil || e.Disabled != "" {
		return ""
	}
	if p.isDefaultPair(i) {
		return p.starred(e.Name, "fleet default")
	}
	return p.starredPair(e.Name, p.pair(d.Model, d.Effort), width, narrow)
}

// gridDefault is the model card's line for the fleet default: the confirmed
// pair, or why it is not known yet.
func (p *picker) gridDefault(width int, narrow bool) string {
	e := p.current()
	if d := p.fleetValue(p.focus); d != nil {
		return p.starredPair(e.Name, p.pair(d.Model, d.Effort), width, narrow)
	}
	state := p.fleet[e.Name]
	switch {
	case state != nil && state.unavailable:
		return p.starred(e.Name, "fleet default  unavailable")
	case state != nil && state.loading:
		return p.starred(e.Name, "fleet default  loading"+p.ellipsis())
	}
	return p.starred(e.Name, "fleet default  unknown")
}

func (p *picker) starred(engine, text string) string {
	return p.paint(p.accent(engine), p.glyphs().star) + " " + p.dim(text)
}

// starredPair writes "★ fleet default  model · effort". A narrow card that
// cannot hold the words keeps the whole pair behind a bare ★ instead, and the
// navigation row then explains the star (p.legend).
func (p *picker) starredPair(engine, pair string, width int, narrow bool) string {
	for _, text := range []string{"fleet default  " + pair, "fleet default " + pair} {
		if 2+ansi.StringWidth(text) <= width || !narrow {
			return p.starred(engine, text)
		}
	}
	p.legend = true
	return p.starred(engine, pair)
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
		return p.dim("usage not reported")
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

// modelCard is the grid: header, the MODEL list and the EFFORT strip, laid out
// like the boot card's labelled sections. ★ marks the fleet-default model and,
// on that model, its effort.
func (p *picker) modelCard(width, height int) []string {
	e := p.current()
	inner := width - 4
	accent := p.accent(e.Name)
	title := p.bold(p.paint(accent, e.Label()))
	if len(e.Models) == 0 {
		return p.card(append([]string{title, ""}, p.emptyState()...), width, true, e.Name)
	}
	if e.Disabled != "" {
		title += "  " + p.paint(p.caps.Palette.Yellow, e.Disabled)
	}
	c := &p.cursors[p.focus]
	content := []string{title, p.quotaBar(p.focus, inner)}
	if p.defaults != nil && e.Disabled == "" {
		content = append(content, p.gridDefault(inner, true))
	}
	rows := min(len(e.Models), max(1, height-7-len(content)))
	p.scroll(rows)
	label := p.dim("MODEL")
	if len(e.Models) > rows {
		label = joinSides(label, p.dim(fmt.Sprintf("%d / %d  more", c.model+1, len(e.Models))), inner)
	}
	content = append(content, "", label)
	starRow := p.defaultRow(p.focus)
	for i := c.offset; i < min(len(e.Models), c.offset+rows); i++ {
		mark := ""
		if i == starRow {
			mark = " " + p.paint(accent, p.glyphs().star)
		}
		name := p.fit(modelName(e.Models[i].ID), inner-2-ansi.StringWidth(mark))
		if i == c.model {
			content = append(content, p.surface(padRight(p.bold(p.paint(accent, "▸ "+name))+mark, inner), true))
			continue
		}
		content = append(content, "  "+p.dim(name)+mark)
	}
	content = append(content, "", p.dim("EFFORT"), p.effortSegments(inner))
	return p.card(content, width, true, e.Name)
}

// emptyState explains an engine without a menu, once, with where to fix it.
func (p *picker) emptyState() []string {
	reason := p.current().Disabled
	if reason == "" {
		reason = noModelsReason
	}
	lines := []string{p.paint(p.caps.Palette.Yellow, reason)}
	if reason == noModelsReason {
		lines = append(lines, p.dim("Check Engines in the admin console."))
	}
	return lines
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
	if len(p.current().Models) == 0 {
		return p.dim(noModelsReason)
	}
	efforts := p.current().Models[c.model].Efforts
	if len(efforts) == 0 {
		return p.dim("no effort setting")
	}
	accent := p.accent(p.current().Name)
	starred := p.defaultEffort(p.focus, c.model)
	star := p.paint(accent, p.glyphs().star)
	segment := func(i int) string {
		if i == c.effort {
			s := p.surface(p.bold(p.paint(accent, "["+efforts[i]+"]")), true)
			if efforts[i] == starred {
				s += star
			}
			return s
		}
		if efforts[i] == starred {
			return p.dim(" "+efforts[i]) + star
		}
		return p.dim(" " + efforts[i] + " ")
	}
	start, end := c.effort, c.effort+1
	out := segment(c.effort)
	for {
		changed := false
		if start > 0 && ansi.StringWidth(out)+ansi.StringWidth(segment(start-1))+1 <= width-4 {
			start--
			out = segment(start) + " " + out
			changed = true
		}
		if end < len(efforts) && ansi.StringWidth(out)+ansi.StringWidth(segment(end))+1 <= width-4 {
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

// keyAction is one entry of the actions row. live=false dims the key: it is
// shown for orientation but does nothing useful right now.
type keyAction struct {
	key, label, short string
	live              bool
}

func (p *picker) keyActions() []keyAction {
	quit := keyAction{key: "q", label: "quit", short: "quit", live: true}
	label, short, live := p.defaultAction()
	if p.saving {
		return []keyAction{{key: "d", label: label, short: short}, quit}
	}
	e := p.current()
	launch := e.Disabled == "" && len(e.Models) > 0
	keys := []keyAction{{"enter", "new", "new", launch}, {"c", "continue", "continue", launch}}
	if e.CanPick() {
		keys = append(keys, keyAction{"r", "resume", "resume", launch})
	}
	if label != "" {
		keys = append(keys, keyAction{"d", label, short, live})
	}
	return append(keys, quit)
}

// actionsLine renders the key chips, degrading from full labels to bare keys
// so every key, including d, survives on narrow terminals.
func (p *picker) actionsLine(width int) string {
	keys := p.keyActions()
	line := ""
	// Widest first: padded chips, then shorter labels and gaps, then bare keys.
	for _, level := range []struct {
		padded bool
		labels int // 0 none, 1 short, 2 full
		gap    string
	}{{true, 2, "   "}, {true, 2, "  "}, {true, 1, "  "}, {false, 1, "  "}, {false, 1, " "}, {true, 0, " "}, {false, 0, " "}} {
		parts := make([]string, len(keys))
		for i, k := range keys {
			chip := k.key
			if level.padded {
				chip = " " + k.key + " "
			}
			if k.live {
				chip = p.surface(chip, true)
			} else {
				chip = p.paint(p.caps.Palette.Border, chip)
			}
			label := k.label
			if level.labels == 1 {
				label = k.short
			}
			switch {
			case level.labels == 0:
			case p.saving && k.key == "d":
				chip += " " + p.paint(p.caps.Palette.Yellow, label) // pending, not idle
			case k.live:
				chip += " " + p.dim(label)
			default:
				chip += " " + p.paint(p.caps.Palette.Border, label)
			}
			parts[i] = chip
		}
		line = strings.Join(parts, level.gap)
		if ansi.StringWidth(line) <= width {
			break
		}
	}
	return line
}

// navLine lists the movement keys; nothing moves while a save is in flight.
// It also explains a bare ★ when a narrow card had no room for the words.
func (p *picker) navLine() string {
	if p.saving {
		return ""
	}
	legend := ""
	if p.legend {
		legend = "   " + p.glyphs().star + " fleet default"
	}
	if p.stage == stageHub {
		return p.dim(p.slotHint() + legend)
	}
	var nav []string
	if len(p.current().Models) > 0 {
		nav = append(nav, "↑↓ model", "←→ effort")
		if !p.richCards() {
			nav = []string{"up/down model", "left/right effort"}
		}
	}
	if len(p.engines) > 1 {
		nav = append(nav, "esc back")
	}
	return p.dim(strings.Join(nav, "   ") + legend)
}

// noticeText is the current notice, minus the saving notice the d key's own
// label already carries.
func (p *picker) noticeText() string {
	if p.saving && p.notice == savingNotice {
		return ""
	}
	return p.notice
}

// footerRows is the fixed height of the rich footer: spacer, actions,
// navigation, notice, spacer.
const footerRows = 5

func (p *picker) footerLines(width int) []string {
	return []string{"", p.fit(p.actionsLine(width), width), p.fit(p.navLine(), width), p.fit(p.paint(p.caps.Palette.Yellow, p.noticeText()), width), ""}
}
func ansiStripText(s string) string { return ansi.Strip(s) }

// Plain/minimal and very small terminals share a compact viewport. Navigation
// and notices get space before decorative content; no off-screen selected row.
func (p *picker) renderCompact(width, height int) string {
	if height < 8 {
		return p.renderTiny(width, height)
	}
	// Bottom block: actions always, then navigation and the wrapped notice.
	// The chosen model and effort keep two rows even when a notice is long.
	minimum := min(len(p.engines), height-1) // one row per compass engine
	if p.stage == stageGrid {
		minimum = 1
		if len(p.current().Models) > 0 {
			minimum = 2
		}
	}
	bottom := []string{p.fit(p.actionsLine(width), width)}
	var notice []string
	if text := p.noticeText(); text != "" {
		notice = strings.Split(ansi.Wrap(p.paint(p.caps.Palette.Yellow, text), width, ""), "\n")
	}
	if nav := p.navLine(); nav != "" && len(bottom)+len(notice)+1+minimum <= height {
		bottom = append(bottom, p.fit(nav, width))
	}
	bottom = append(bottom, notice[:min(len(notice), max(0, height-minimum-len(bottom)))]...)
	var lines []string
	if p.stage == stageHub {
		lines = p.compactHub(width, height-len(bottom))
	} else {
		lines = p.compactGrid(width, height-len(bottom))
	}
	lines = append(lines[:min(len(lines), height-len(bottom))], bottom...)
	for i := range lines {
		lines[i] = p.fit(lines[i], width)
	}
	return strings.Join(lines[:min(height, len(lines))], "\n")
}

func (p *picker) compactTitle() string { return p.bold("cxx") + p.dim(" / launchpad") }

// compactHub lists the engines one per row; usage and fleet default follow on
// a second row when every engine has room for one.
func (p *picker) compactHub(width, avail int) []string {
	labels := make([]string, len(p.engines))
	labelWidth := 0
	for i, e := range p.engines {
		labels[i] = e.Label() + " (" + []string{"left", "right", "down", "up"}[i] + ")"
		labelWidth = max(labelWidth, ansi.StringWidth(labels[i]))
	}
	var main, extra []string
	for i, e := range p.engines {
		marker, label := "  ", padRight(labels[i], labelWidth)
		if i == p.focus {
			marker, label = p.bold(p.paint(p.accent(e.Name), "> ")), p.bold(p.paint(p.accent(e.Name), label))
		}
		detail := p.summary(i)
		if i == p.focus {
			detail = ansi.Strip(detail)
		}
		if e.Disabled != "" {
			detail = p.paint(p.caps.Palette.Yellow, e.Disabled)
		}
		main = append(main, marker+label+"  "+detail)
		note := ""
		if e.Name != config.EngineGrok && e.Disabled == "" {
			note = p.weeklyNotice(i)
		}
		room := width - 4
		if note != "" {
			room -= ansi.StringWidth(note) + 3
		}
		if d := p.hubDefault(i, room, false); d != "" {
			note = strings.TrimSpace(note + "   " + d)
		}
		extra = append(extra, note)
	}
	withExtra := 0
	for _, note := range extra {
		if note != "" {
			withExtra++
		}
	}
	showTitle, showBlank, showExtra := true, true, true
	for {
		n := len(main)
		if showExtra {
			n += withExtra
		}
		if showTitle {
			n++
		}
		if showBlank {
			n++
		}
		if n <= avail || (!showTitle && !showBlank && !showExtra) {
			break
		}
		switch {
		case showExtra:
			showExtra = false
		case showBlank:
			showBlank = false
		default:
			showTitle = false
		}
	}
	var lines []string
	if showTitle {
		lines = append(lines, p.compactTitle())
	}
	for i := range main {
		lines = append(lines, main[i])
		if showExtra && extra[i] != "" {
			lines = append(lines, strings.Repeat(" ", 4)+extra[i])
		}
	}
	if showBlank {
		lines = append(lines, "")
	}
	return lines
}

// compactGrid keeps the chosen model and its effort strip on screen first,
// then the engine header, the fleet-default legend, further models and the
// title, in that order.
func (p *picker) compactGrid(width, avail int) []string {
	e := p.current()
	header := p.bold(p.paint(p.accent(e.Name), e.Label()))
	if len(e.Models) == 0 {
		lines := append([]string{p.compactTitle(), header}, p.emptyState()...)
		return lines[max(0, len(lines)-max(1, avail)):]
	}
	if e.Disabled != "" {
		header += "  " + p.paint(p.caps.Palette.Yellow, e.Disabled)
	} else {
		header += "  " + p.weeklyNotice(p.focus)
	}
	status := ""
	if p.defaults != nil && e.Disabled == "" {
		status = p.gridDefault(width, false)
	}
	showTitle, showHeader, showStatus, showBlank := true, true, status != "", true
	rows := len(e.Models)
	count := func() int {
		n := rows + 1 // models and the effort strip
		for _, on := range []bool{showTitle, showHeader, showStatus, showBlank} {
			if on {
				n++
			}
		}
		return n
	}
	// Drop the least useful line until the block fits; the selected row and
	// its effort strip are never dropped.
	for count() > avail {
		switch {
		case rows > min(3, len(e.Models)):
			rows--
		case showBlank:
			showBlank = false
		case showTitle:
			showTitle = false
		case rows > 1:
			rows--
		case showStatus:
			showStatus = false
		case showHeader:
			showHeader = false
		default:
			avail = count() // nothing left to drop
		}
	}
	p.scroll(rows)
	c := p.cursors[p.focus]
	if rows < len(e.Models) {
		header += "  " + p.dim(fmt.Sprintf("%d / %d  more", c.model+1, len(e.Models)))
	}
	var lines []string
	if showTitle {
		lines = append(lines, p.compactTitle())
	}
	if showHeader {
		lines = append(lines, header)
	}
	if showStatus {
		lines = append(lines, status)
	}
	starRow := p.defaultRow(p.focus)
	for i := c.offset; i < min(len(e.Models), c.offset+rows); i++ {
		mark := ""
		if i == starRow {
			mark = " " + p.paint(p.accent(e.Name), p.glyphs().star)
		}
		name := p.fit(modelName(e.Models[i].ID), width-2-ansi.StringWidth(mark))
		if i == c.model {
			lines = append(lines, p.bold(p.paint(p.accent(e.Name), "> "+name))+mark)
		} else {
			lines = append(lines, "  "+p.dim(name)+mark)
		}
	}
	lines = append(lines, p.effortSegments(width))
	if showBlank {
		lines = append(lines, "")
	}
	return lines
}

// renderTiny serves terminals under eight rows: the choice and one action row.
func (p *picker) renderTiny(width, height int) string {
	lines := []string{p.fit(p.current().Label()+" "+ansiStripText(p.summary(p.focus)), width), p.fit("enter new  c continue  q quit", width)}
	if label, _, _ := p.defaultAction(); label != "" {
		lines[1] = p.fit("enter new  d default  q quit", width)
		if p.stage == stageGrid && len(p.current().Models) > 0 {
			c := p.cursors[p.focus]
			action := "d default enter q"
			if p.saving {
				action = "q quit / saving"
			}
			lines = []string{p.fit("> "+modelName(p.current().Models[c.model].ID), width), p.effortSegments(width), p.fit(action, width)}
			if p.isFleetDefault() {
				lines = append(lines, "fleet default")
			}
		}
	}
	if p.notice != "" {
		lines = append(lines, strings.Split(ansi.Wrap(p.notice, width, ""), "\n")...)
	}
	return strings.Join(lines[:min(height, len(lines))], "\n")
}
