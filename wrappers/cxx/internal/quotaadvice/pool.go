package quotaadvice

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

// poolLabelCells bounds an account label in the comparison so long e-mail
// addresses do not squeeze the bars of every row.
const poolLabelCells = 28

func percentText(v *float64) string {
	if v == nil {
		return "-"
	}
	return strconv.Itoa(int(math.Round(*v))) + "%"
}

func (a PoolAccount) usage() []string {
	if a.ShortUsed == nil && a.WeeklyUsed == nil {
		return []string{"no reading"}
	}
	return []string{"5h " + percentText(a.ShortUsed), "7d " + percentText(a.WeeklyUsed)}
}

// used is the account's position on the bar: the server's pool score, else
// the higher reported window, else zero for an account without a reading.
func (a PoolAccount) used() int {
	v := a.Score
	if v == nil {
		for _, w := range []*float64{a.ShortUsed, a.WeeklyUsed} {
			if w != nil && (v == nil || *w > *v) {
				v = w
			}
		}
	}
	if v == nil {
		return 0
	}
	return int(math.Round(*v))
}

// state names what an account is to this launch.
func (p *Pool) state(a PoolAccount) string {
	switch {
	case !a.Usable:
		return "unavailable"
	case p.BoundAccountID != nil && *p.BoundAccountID == a.ID:
		return "in use"
	case p.BoundAccountID == nil && p.LaunchAccountID != nil && *p.LaunchAccountID == a.ID:
		return "next launch"
	}
	return ""
}

// Summary is the one-line pool description for non-interactive hints:
// "#1 a@example.com 5h 12% 7d 87% (in use), #8 b@example.com no reading".
func (p *Pool) Summary() string {
	if !p.Multi() {
		return ""
	}
	parts := make([]string, 0, len(p.Accounts))
	for _, a := range p.Accounts {
		part := fmt.Sprintf("#%d %s %s", a.ID, terminalui.CleanInline(a.Label), strings.Join(a.usage(), " "))
		if state := p.state(a); state != "" {
			part += " (" + state + ")"
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, ", ")
}

// compareRows renders the accounts as comparison rows below the engine bars.
func (p *Pool) compareRows(caps terminalui.Caps) []terminalui.QuotaCompare {
	rows := make([]terminalui.QuotaCompare, 0, len(p.Accounts))
	for _, a := range p.Accounts {
		detail := a.usage()
		if state := p.state(a); state != "" {
			detail = append(detail, state)
		}
		label := terminalui.TruncateText(fmt.Sprintf("#%d %s", a.ID, a.Label), poolLabelCells, caps)
		rows = append(rows, terminalui.QuotaCompare{Label: label, Used: a.used(), Detail: detail})
	}
	return rows
}

// poolBody lists every pool of the comparison under a dim heading, indented
// below the engine rows.
func poolBody(caps terminalui.Caps, width int, pools ...namedPool) []string {
	var lines []string
	for _, np := range pools {
		if !np.pool.Multi() {
			continue
		}
		lines = append(lines, "  "+caps.Palette.Dim+np.name+" accounts"+caps.Palette.Reset)
		for _, line := range terminalui.QuotaCompareLines(caps, np.pool.compareRows(caps), max(1, width-2)) {
			lines = append(lines, "  "+line)
		}
	}
	return lines
}

type namedPool struct {
	name string
	pool *Pool
}

// poolDetails adds one summary line per pool to a hint's detail lines.
func poolDetails(pools ...namedPool) []string {
	var details []string
	for _, np := range pools {
		if summary := np.pool.Summary(); summary != "" {
			details = append(details, np.name+" pool: "+summary)
		}
	}
	return details
}
