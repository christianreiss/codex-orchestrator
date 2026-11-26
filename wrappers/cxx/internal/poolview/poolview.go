// Package poolview presents an engine's provider-account pool on the startup
// card, `status` and `doctor` of every persona. It only reads what the server
// already reports (`quota_pool` on /auth and /sync/bootstrap, GET
// /auth/accounts); it never selects or switches an account itself.
package poolview

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

// Account is one entry of `quota_pool.accounts` or GET /auth/accounts.
type Account struct {
	ID                int64    `json:"id"`
	Label             string   `json:"label"`
	Email             *string  `json:"email,omitempty"`
	State             string   `json:"state"`
	Verified          bool     `json:"verified"`
	Plan              *string  `json:"plan,omitempty"`
	ShortUsedPercent  *float64 `json:"short_used_percent"`
	ShortResetsAt     *string  `json:"short_resets_at,omitempty"`
	WeeklyUsedPercent *float64 `json:"weekly_used_percent"`
	WeeklyResetsAt    *string  `json:"weekly_resets_at,omitempty"`
	FetchedAt         *string  `json:"fetched_at,omitempty"`
	Score             *float64 `json:"score"`
	EmulationBlocked  bool     `json:"emulation_blocked,omitempty"`
	ActiveSessions    int      `json:"active_sessions,omitempty"`
}

// Usable mirrors the server: only enabled, verified accounts take work.
func (a Account) Usable() bool { return a.State == "enabled" && a.Verified }

// Policy is the engine's distribution policy (a subset on /auth).
type Policy struct {
	Mode            string `json:"mode"`
	Strategy        string `json:"strategy"`
	Spread          string `json:"spread,omitempty"`
	SpreadPoints    int    `json:"spread_points,omitempty"`
	SoftCeiling     int    `json:"soft_ceiling,omitempty"`
	HardCeiling     int    `json:"hard_ceiling,omitempty"`
	MinDwellMinutes int    `json:"min_dwell_minutes,omitempty"`
}

// Recommendation: action is continue, switch or pause. pause means the whole
// pool is at its limit; the others mean work can go on.
type Recommendation struct {
	Action    string `json:"action"`
	AccountID *int64 `json:"account_id,omitempty"`
	Message   string `json:"message"`
}

// QuotaPool is `quota_pool` of /auth and /sync/bootstrap, present when the
// engine has more than one account. Headroom is the server's verdict that
// another usable account is below the policy ceiling (nil: older server).
type QuotaPool struct {
	Recommendation  *Recommendation `json:"recommendation,omitempty"`
	Policy          *Policy         `json:"policy,omitempty"`
	BoundAccountID  *int64          `json:"bound_account_id,omitempty"`
	Headroom        *bool           `json:"headroom,omitempty"`
	LaunchAccountID *int64          `json:"launch_account_id,omitempty"`
	LiveSwitch      bool            `json:"live_switch,omitempty"`
	Accounts        []Account       `json:"accounts,omitempty"`
}

// View is GET /auth/accounts.
type View struct {
	Engine            string                       `json:"engine"`
	Policy            *Policy                      `json:"policy"`
	BoundAccountID    *int64                       `json:"bound_account_id"`
	BindingGeneration *int64                       `json:"binding_generation"`
	AccountSwitch     *accountpool.SwitchDirective `json:"account_switch"`
	LiveSwitch        bool                         `json:"live_switch"`
	Accounts          []Account                    `json:"accounts"`
	Recommendation    *Recommendation              `json:"recommendation"`
}

// State is the presentation model shared by card, status and doctor.
type State struct {
	Policy         *Policy
	BoundID        int64
	Generation     *int64
	Pending        *accountpool.SwitchDirective
	LaunchID       int64
	LiveSwitch     bool
	Headroom       *bool
	Accounts       []Account
	Recommendation *Recommendation
}

func id(v *int64) int64 {
	if v == nil {
		return 0
	}
	return *v
}

// FromQuotaPool builds the state of an /auth answer. boundFallback is the
// answer's account_id for servers that do not name the bound account; the
// pending switch and generation come from the same answer when present.
func FromQuotaPool(q *QuotaPool, boundFallback int64, pending *accountpool.SwitchDirective, generation *int64) *State {
	if q == nil {
		return nil
	}
	bound := id(q.BoundAccountID)
	if bound == 0 {
		bound = boundFallback
	}
	return &State{Policy: q.Policy, BoundID: bound, Generation: generation, Pending: pending, LaunchID: id(q.LaunchAccountID),
		LiveSwitch: q.LiveSwitch, Headroom: q.Headroom, Accounts: q.Accounts, Recommendation: q.Recommendation}
}

// FromView builds the state of GET /auth/accounts. localBound is this
// scope's binding file, used when the server answered without a session.
func FromView(v *View, localBound int64) *State {
	if v == nil {
		return nil
	}
	bound := id(v.BoundAccountID)
	if bound == 0 {
		bound = localBound
	}
	return &State{Policy: v.Policy, BoundID: bound, Generation: v.BindingGeneration, Pending: v.AccountSwitch,
		LiveSwitch: v.LiveSwitch, Accounts: v.Accounts, Recommendation: v.Recommendation}
}

// Card lists the pool on a startup card whose auth answer may predate the
// run's lease (Grok, Kimi): accountID is the account the run actually uses.
// When the lease picked another account than the answer's, the server's
// headroom verdict (computed for the old binding) gives way to the local
// rule. It returns the rows and the note; nothing for a single account.
func Card(q *QuotaPool, accountID int64, warnAt, limit int, now time.Time) ([]terminalui.QuotaAccount, string) {
	s := FromQuotaPool(q, accountID, nil, nil)
	if !s.Multi() {
		return nil, ""
	}
	if accountID > 0 && s.BoundID != accountID {
		s.BoundID, s.Headroom = accountID, nil
	}
	return s.Rows(warnAt, limit, now), s.Note(limit)
}

// Multi reports a pool with more than one account: only then is anything shown.
func (s *State) Multi() bool { return s != nil && len(s.Accounts) > 1 }

func (s *State) account(id int64) *Account {
	for i := range s.Accounts {
		if s.Accounts[i].ID == id {
			return &s.Accounts[i]
		}
	}
	return nil
}

func scoreOf(a Account) float64 {
	if a.Score != nil {
		return *a.Score
	}
	return 0
}

// ceiling mirrors the server's policyCeiling: the fleet quota limit, or the
// hard ceiling under the automatic exhaust strategy.
func (s *State) ceiling(limit int) int {
	if p := s.Policy; p != nil && p.Mode == "auto" && p.Strategy == "exhaust" && p.HardCeiling > 0 {
		return p.HardCeiling
	}
	return limit
}

// HasHeadroom reports whether another usable account can take work below the
// ceiling: the server's verdict when present, else the same rule locally
// (unmeasured accounts count as unused; limit is the fleet quota limit; a
// budget-blocked account reports score 100 and never counts).
func (s *State) HasHeadroom(limit int) bool {
	if !s.Multi() {
		return false
	}
	if s.Headroom != nil {
		return *s.Headroom
	}
	ceiling := float64(s.ceiling(limit))
	for _, a := range s.Accounts {
		if a.ID != s.BoundID && a.Usable() && !a.EmulationBlocked && scoreOf(a) < ceiling {
			return true
		}
	}
	return false
}

func roundPtr(v *float64) *int {
	if v == nil {
		return nil
	}
	r := int(math.Round(*v))
	return &r
}

// Label is the short account name used by the statusline and notes: "#8
// label" (label omitted when empty).
func Label(id int64, label string) string {
	label = terminalui.CleanInline(label)
	if label == "" {
		return fmt.Sprintf("#%d", id)
	}
	return fmt.Sprintf("#%d %s", id, label)
}

func stale(a Account, now time.Time) string {
	if a.FetchedAt == nil {
		return ""
	}
	at, err := time.Parse(time.RFC3339, strings.TrimSpace(*a.FetchedAt))
	if err != nil || now.Sub(at) < time.Hour {
		return ""
	}
	return "reported " + terminalui.DurationShort(now.Sub(at)) + " ago"
}

// note names an account's role and the one state worth knowing.
func (s *State) note(a Account, limit int, now time.Time) (string, terminalui.Tone) {
	switch {
	case a.State != "enabled":
		return strings.TrimSpace(a.State), terminalui.ToneWarn
	case !a.Verified:
		return "unverified", terminalui.ToneWarn
	case a.EmulationBlocked:
		return "budget blocked", terminalui.ToneWarn
	}
	role := ""
	switch {
	case a.ID == s.BoundID:
		role = "in use"
	case s.Pending != nil && s.Pending.AccountID == a.ID:
		role = "switching here"
	case s.BoundID == 0 && s.LaunchID == a.ID:
		role = "next launch"
	}
	extra, tone := "", terminalui.ToneDim
	if a.Score != nil && *a.Score >= float64(limit) {
		extra, tone = "at limit", terminalui.ToneWarn
	} else if old := stale(a, now); old != "" {
		extra = old
	}
	switch {
	case role != "" && extra != "":
		return role + ", " + extra, tone
	case role != "":
		return role, tone
	}
	return extra, tone
}

// Rows lists every account for the QUOTA section. warnAt/limit colour the
// percentages like the quota bars.
func (s *State) Rows(warnAt, limit int, now time.Time) []terminalui.QuotaAccount {
	if !s.Multi() {
		return nil
	}
	rows := make([]terminalui.QuotaAccount, 0, len(s.Accounts))
	for _, a := range s.Accounts {
		note, tone := s.note(a, limit, now)
		rows = append(rows, terminalui.QuotaAccount{
			ID: a.ID, Label: a.Label, Short: roundPtr(a.ShortUsedPercent), Weekly: roundPtr(a.WeeklyUsedPercent),
			Bound: a.ID == s.BoundID, Target: s.Pending != nil && s.Pending.AccountID == a.ID && a.ID != s.BoundID,
			Note: note, NoteTone: tone, WarnAtPct: warnAt, BlockAtPct: limit,
		})
	}
	return rows
}

// PolicyText is "policy auto/balanced" (empty without a policy).
func (s *State) PolicyText() string {
	if s == nil || s.Policy == nil || s.Policy.Mode == "" {
		return ""
	}
	if s.Policy.Strategy == "" || s.Policy.Mode == "manual" {
		return "policy " + s.Policy.Mode
	}
	return "policy " + s.Policy.Mode + "/" + s.Policy.Strategy
}

// PendingText describes a pending switch, or "".
func (s *State) PendingText() string {
	if s == nil || s.Pending == nil || s.Pending.AccountID == s.BoundID {
		return ""
	}
	text := "switch to " + Label(s.Pending.AccountID, s.Pending.AccountLabel) + " pending"
	if reason := strings.TrimSpace(s.Pending.Reason); reason != "" {
		text += " (" + reason + ")"
	}
	if s.LiveSwitch {
		return text + ", at the next turn boundary"
	}
	return text + ", at the next launch"
}

// Note is the dim line under the account rows: policy, binding, pending
// switch and the server's recommendation when the pool has room or is full.
func (s *State) Note(limit int) string {
	if !s.Multi() {
		return ""
	}
	parts := []string{fmt.Sprintf("Account pool: %d accounts", len(s.Accounts))}
	if policy := s.PolicyText(); policy != "" {
		parts = append(parts, policy)
	}
	if s.BoundID > 0 {
		bound := "bound " + fmt.Sprintf("#%d", s.BoundID)
		if s.Generation != nil {
			bound += fmt.Sprintf(" (generation %d)", *s.Generation)
		}
		parts = append(parts, bound)
	}
	if pending := s.PendingText(); pending != "" {
		parts = append(parts, pending)
	}
	text := strings.Join(parts, "; ") + "."
	if s.HasHeadroom(limit) {
		// The server's message is worth repeating when it plans a move or
		// names the pool; "Account X is at N%" only restates the rows.
		message, action := "", ""
		if r := s.Recommendation; r != nil {
			message, action = strings.TrimSpace(r.Message), strings.ToLower(strings.TrimSpace(r.Action))
		}
		if message != "" && action != "pause" && (action == "switch" || strings.Contains(message, "pool:")) {
			text += " " + message
		} else {
			text += " Another account has headroom; keep working."
		}
	} else if r := s.Recommendation; r != nil && strings.EqualFold(strings.TrimSpace(r.Action), "pause") && strings.TrimSpace(r.Message) != "" {
		text += " " + strings.TrimSpace(r.Message)
	}
	return text
}

// usageText is the compact per-account usage of the doctor row:
// "#1 87%, #8 no reading" (the higher window, as the pool scores it).
func (s *State) usageText() string {
	parts := make([]string, 0, len(s.Accounts))
	for _, a := range s.Accounts {
		used := a.Score
		if used == nil {
			for _, w := range []*float64{a.ShortUsedPercent, a.WeeklyUsedPercent} {
				if w != nil && (used == nil || *w > *used) {
					used = w
				}
			}
		}
		if used == nil {
			parts = append(parts, fmt.Sprintf("#%d no reading", a.ID))
		} else {
			parts = append(parts, fmt.Sprintf("#%d %d%%", a.ID, int(math.Round(*used))))
		}
	}
	return strings.Join(parts, ", ")
}

// Check is the doctor verdict for a pool: real problems only, never one high
// account in a pool that still has headroom.
type Check struct {
	Tone  terminalui.Tone
	Value string
	Hint  string
}

// Doctor evaluates the pool. limit is the fleet quota limit percent;
// addCommand ("clx accounts add") is offered when no account is usable.
func (s *State) Doctor(limit int, addCommand string) Check {
	usable := 0
	for _, a := range s.Accounts {
		if a.Usable() {
			usable++
		}
	}
	summary := fmt.Sprintf("%d accounts, %d usable", len(s.Accounts), usable)
	if policy := s.PolicyText(); policy != "" {
		summary += "; " + policy
	}
	if s.BoundID > 0 {
		summary += fmt.Sprintf("; bound #%d", s.BoundID)
		if s.Generation != nil {
			summary += fmt.Sprintf(" (generation %d)", *s.Generation)
		}
	}
	if pending := s.PendingText(); pending != "" {
		summary += "; " + pending
	}
	if usage := s.usageText(); usage != "" {
		summary += "; " + usage
	}
	if usable == 0 {
		hint := "Verify or re-enable an account on the admin Accounts page."
		if addCommand != "" {
			hint = "Verify or re-enable an account on the admin Accounts page, or sign one in with `" + addCommand + "`."
		}
		return Check{terminalui.ToneFail, summary + "; no usable account", hint}
	}
	if bound := s.account(s.BoundID); s.BoundID > 0 && (bound == nil || !bound.Usable()) {
		state := "removed"
		if bound != nil {
			state = bound.State
			if bound.State == "enabled" {
				state = "unverified"
			}
		}
		return Check{terminalui.ToneWarn, summary + fmt.Sprintf("; bound account #%d is %s", s.BoundID, state), "The next launch (or the pool policy) moves this scope to a usable account."}
	}
	if r := s.Recommendation; r != nil && strings.EqualFold(r.Action, "pause") {
		return Check{terminalui.ToneWarn, summary + "; every account is at its limit", strings.TrimSpace(r.Message)}
	}
	if !s.HasHeadroom(limit) {
		if bound := s.account(s.BoundID); bound != nil && scoreOf(*bound) >= float64(s.ceiling(limit)) {
			return Check{terminalui.ToneWarn, summary + "; every account is at its limit", ""}
		}
	}
	return Check{terminalui.ToneOK, summary, ""}
}

// DoctorRow reads the scope's pool and returns the doctor's "Accounts" row
// and hint. ok is false for a single-account engine or when the pool cannot
// be read (the Sync row already reports an unreachable API). limit is the
// auth answer's quota_limit_percent (nil: the server default, 95).
func DoctorRow(ctx context.Context, client accountpool.Client, pool *accountpool.Context, engine string, limit *int, addCommand string) (terminalui.DoctorRow, string, bool) {
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	view, _, err := Fetch(callCtx, client, pool, engine)
	if err != nil {
		return terminalui.DoctorRow{}, "", false
	}
	local, _ := pool.Binding()
	state := FromView(view, local)
	if !state.Multi() {
		return terminalui.DoctorRow{}, "", false
	}
	pct := 95
	if limit != nil {
		pct = max(50, min(100, *limit))
	}
	check := state.Doctor(pct, addCommand)
	return terminalui.DoctorRow{Label: "Accounts", Tone: check.Tone, Value: check.Value}, check.Hint, true
}

// ForStatus reads the full pool view (binding generation, pending switch,
// policy) for `status` when the auth answer reports more than one account.
// A failed read returns nil, so the card falls back to the answer's own
// quota_pool. GET /auth/accounts has no headroom verdict; the answer's
// verdict is kept when both name the same bound account.
func ForStatus(ctx context.Context, client accountpool.Client, pool *accountpool.Context, engine string, q *QuotaPool, accountID int64) *State {
	if q == nil || len(q.Accounts) < 2 {
		return nil
	}
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	view, _, err := Fetch(callCtx, client, pool, engine)
	if err != nil {
		return nil
	}
	local, _ := pool.Binding()
	state := FromView(view, local)
	if state != nil && state.BoundID == accountID {
		state.Headroom = q.Headroom
	}
	return state
}

// Sessions lists live lease IDs of this scope: the inherited one inside a
// managed session first, then the markers of running wrappers.
func Sessions(pool *accountpool.Context) []string {
	var ids []string
	if env := strings.TrimSpace(os.Getenv("CXX_PROVIDER_SESSION_ID")); env != "" {
		ids = append(ids, env)
	}
	for _, id := range pool.LiveSessions() {
		if len(ids) == 0 || id != ids[0] {
			ids = append(ids, id)
		}
	}
	return ids
}

func notFound(err error) bool {
	var status interface{ HTTPStatus() int }
	return errors.As(err, &status) && status.HTTPStatus() == http.StatusNotFound
}

// Fetch reads GET /auth/accounts for this scope: with the first live session
// the server recognises (binding generation, pending switch), else without a
// session. It returns the raw body too, for `accounts list --json`.
func Fetch(ctx context.Context, client accountpool.Client, pool *accountpool.Context, engine string) (*View, json.RawMessage, error) {
	var raw json.RawMessage
	err := errors.New("no session")
	for _, session := range Sessions(pool) {
		raw, err = accountpool.ListAccounts(ctx, client, engine, session)
		if err == nil || !notFound(err) {
			break
		}
	}
	if err != nil && (notFound(err) || err.Error() == "no session") {
		raw, err = accountpool.ListAccounts(ctx, client, engine, "")
	}
	if err != nil {
		return nil, nil, err
	}
	var view View
	if err := json.Unmarshal(raw, &view); err != nil {
		return nil, raw, fmt.Errorf("unexpected server answer: %w", err)
	}
	return &view, raw, nil
}
