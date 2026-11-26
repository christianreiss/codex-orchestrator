package claudeapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
)

const accountsUsage = `Usage:
  clx accounts [list] [--json]   Show the account pool, policy and this scope's binding
  clx accounts add [args...]     Sign in another Claude account through an isolated login
  clx accounts use <id|auto>     Switch running sessions of this scope at the next turn boundary
`

// enrollStaleAfter bounds how long an abandoned enrollment directory (a
// killed `clx accounts add`) may keep credentials on disk.
const enrollStaleAfter = time.Hour

type accountsView struct {
	Engine string `json:"engine"`
	Policy *struct {
		Mode            string `json:"mode"`
		Strategy        string `json:"strategy"`
		Spread          string `json:"spread"`
		SpreadPoints    int    `json:"spread_points"`
		SoftCeiling     int    `json:"soft_ceiling"`
		HardCeiling     int    `json:"hard_ceiling"`
		MinDwellMinutes int    `json:"min_dwell_minutes"`
	} `json:"policy"`
	BoundAccountID    *int64                       `json:"bound_account_id"`
	BindingGeneration *int64                       `json:"binding_generation"`
	AccountSwitch     *accountpool.SwitchDirective `json:"account_switch"`
	Accounts          []struct {
		ID                int64    `json:"id"`
		Label             string   `json:"label"`
		Email             *string  `json:"email"`
		State             string   `json:"state"`
		Verified          bool     `json:"verified"`
		Plan              *string  `json:"plan"`
		ShortUsedPercent  *float64 `json:"short_used_percent"`
		WeeklyUsedPercent *float64 `json:"weekly_used_percent"`
		ActiveSessions    int      `json:"active_sessions"`
	} `json:"accounts"`
	Recommendation *struct {
		Action    string `json:"action"`
		AccountID *int64 `json:"account_id"`
		Message   string `json:"message"`
	} `json:"recommendation"`
}

func cmdAccounts(ctx context.Context, cfg *config.Config, args []string, stdout, stderr io.Writer) int {
	op := "list"
	if len(args) > 0 {
		op, args = args[0], args[1:]
	}
	switch op {
	case "-h", "--help", "help":
		fmt.Fprint(stdout, accountsUsage)
		return 0
	case "--json":
		return accountsList(ctx, cfg, append([]string{"--json"}, args...), stdout, stderr)
	case "list":
		return accountsList(ctx, cfg, args, stdout, stderr)
	case "add":
		return accountsAdd(ctx, cfg, args, stdout, stderr)
	case "use":
		return accountsUse(ctx, cfg, args, stdout, stderr)
	}
	ui.Say(stderr, "clx", ui.ToneFail, "accounts", "unbekannter Unterbefehl: "+op)
	fmt.Fprint(stderr, accountsUsage)
	return 2
}

func accountsClient(cfg *config.Config) (*orchestrator.Client, *accountpool.Context, error) {
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		CABundlePath:  caBundlePath(cfg),
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		return nil, nil, err
	}
	authPath, err := claude.AuthPath()
	if err != nil {
		return nil, nil, err
	}
	client.Pool = accountpool.Load("claude", authPath, client.BaseURL)
	return client, client.Pool, nil
}

// scopeSessions lists live lease IDs of this scope: the inherited one inside
// a managed session first, then the markers of running wrappers.
func scopeSessions(pool *accountpool.Context) []string {
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

func isNotFound(err error) bool {
	var httpErr *orchestrator.HTTPError
	return errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusNotFound
}

func serverError(err error) string {
	var httpErr *orchestrator.HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.ServerMessage()
	}
	return err.Error()
}

func accountsList(ctx context.Context, cfg *config.Config, args []string, stdout, stderr io.Writer) int {
	asJSON := false
	for _, arg := range args {
		switch arg {
		case "--json":
			asJSON = true
		case "-h", "--help":
			fmt.Fprint(stdout, accountsUsage)
			return 0
		default:
			ui.Say(stderr, "clx", ui.ToneFail, "accounts", "unbekanntes Argument: "+arg)
			return 2
		}
	}
	client, pool, err := accountsClient(cfg)
	if err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", err.Error())
		return 1
	}
	callCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var raw json.RawMessage
	err = errors.New("no session")
	for _, session := range scopeSessions(pool) {
		raw, err = accountpool.ListAccounts(callCtx, client, "claude", session)
		if err == nil || !isNotFound(err) {
			break
		}
	}
	if err != nil && (isNotFound(err) || err.Error() == "no session") {
		raw, err = accountpool.ListAccounts(callCtx, client, "claude", "")
	}
	if err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", serverError(err))
		return 1
	}
	if asJSON {
		fmt.Fprintln(stdout, string(raw))
		return 0
	}
	var view accountsView
	if err := json.Unmarshal(raw, &view); err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", "unerwartete Serverantwort: "+err.Error())
		return 1
	}
	printAccounts(stdout, view, pool.AccountID)
	return 0
}

func percentCell(v *float64) string {
	if v == nil {
		return "–"
	}
	return strconv.Itoa(int(*v+0.5)) + " %"
}

func printAccounts(w io.Writer, view accountsView, localBinding int64) {
	bound := localBinding
	if view.BoundAccountID != nil {
		bound = *view.BoundAccountID
	}
	if p := view.Policy; p != nil {
		line := fmt.Sprintf("Policy: %s · %s", p.Mode, p.Strategy)
		if p.Strategy == "balanced" {
			line += fmt.Sprintf(" · band %s (%d points)", p.Spread, p.SpreadPoints)
		} else {
			line += fmt.Sprintf(" · Grenzen %d/%d %%", p.SoftCeiling, p.HardCeiling)
		}
		line += fmt.Sprintf(" · dwell %d min", p.MinDwellMinutes)
		fmt.Fprintln(w, line)
	}
	if len(view.Accounts) == 0 {
		fmt.Fprintln(w, "No Claude accounts in the pool. Sign in with clx login (first) or clx accounts add (more).")
		return
	}
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "\tID\tACCOUNT\tSTATE\tVERIFIED\t5H\t7D\tPLAN\tSESSIONS")
	for _, a := range view.Accounts {
		marker := ""
		if a.ID == bound {
			marker = "*"
		}
		label := a.Label
		if a.Email != nil && *a.Email != "" && *a.Email != label {
			label += " <" + *a.Email + ">"
		}
		verified := "no"
		if a.Verified {
			verified = "yes"
		}
		plan := "–"
		if a.Plan != nil && *a.Plan != "" {
			plan = *a.Plan
		}
		fmt.Fprintf(tw, "%s\t%d\t%s\t%s\t%s\t%s\t%s\t%s\t%d\n", marker, a.ID, label, a.State, verified, percentCell(a.ShortUsedPercent), percentCell(a.WeeklyUsedPercent), plan, a.ActiveSessions)
	}
	_ = tw.Flush()
	if bound > 0 {
		line := fmt.Sprintf("Bound: #%d", bound)
		if view.BindingGeneration != nil {
			line += fmt.Sprintf(" (Generation %d)", *view.BindingGeneration)
		}
		fmt.Fprintln(w, line)
	}
	if d := view.AccountSwitch; d != nil {
		fmt.Fprintf(w, "Pending switch: → #%d %s (reason: %s), effective at the next turn boundary\n", d.AccountID, d.AccountLabel, d.Reason)
	}
	if r := view.Recommendation; r != nil && strings.TrimSpace(r.Message) != "" {
		fmt.Fprintf(w, "Recommendation (%s): %s\n", r.Action, r.Message)
	}
}

func accountsUse(ctx context.Context, cfg *config.Config, args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 || args[0] == "-h" || args[0] == "--help" {
		fmt.Fprint(stderr, accountsUsage)
		return 2
	}
	var target any = "auto"
	if args[0] != "auto" {
		id, err := strconv.ParseInt(strings.TrimPrefix(args[0], "#"), 10, 64)
		if err != nil || id <= 0 {
			ui.Say(stderr, "clx", ui.ToneFail, "accounts", `Ziel muss eine Account-ID oder "auto" sein`)
			return 2
		}
		target = id
	}
	client, pool, err := accountsClient(cfg)
	if err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", err.Error())
		return 1
	}
	sessions := scopeSessions(pool)
	if len(sessions) == 0 {
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", "no running session in this scope; switching the next launch is not supported yet")
		return 1
	}
	callCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var res *accountpool.SwitchRequestResult
	for _, session := range sessions {
		res, err = accountpool.RequestSwitch(callCtx, client, "claude", session, target, "host")
		if err == nil || !isNotFound(err) {
			break
		}
	}
	if err != nil {
		if isNotFound(err) {
			ui.Say(stderr, "clx", ui.ToneFail, "accounts", "no running session in this scope; switching the next launch is not supported yet")
			return 1
		}
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", serverError(err))
		return 1
	}
	if res.AccountSwitch == nil {
		ui.Say(stdout, "clx", ui.ToneOK, "accounts", fmt.Sprintf("no switch needed: account #%d stays bound", res.BoundAccountID))
		return 0
	}
	name := res.AccountSwitch.AccountLabel
	if name == "" {
		name = "Account"
	}
	ui.Say(stdout, "clx", ui.ToneOK, "accounts", fmt.Sprintf("switch to #%d %s requested; running sessions switch at the next turn boundary", res.AccountSwitch.AccountID, name))
	return 0
}

// enrollRoot is the private parent of enrollment directories. It lives under
// the home directory, never /tmp (a tmpfs on fleet hosts keeps it in RAM and
// may be shared); stale leftovers of killed runs are removed first.
func enrollRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	root := filepath.Join(home, ".cxx", "claude-enroll")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(root, 0o700); err != nil {
		return "", err
	}
	if entries, err := os.ReadDir(root); err == nil {
		for _, entry := range entries {
			if info, err := entry.Info(); err == nil && time.Since(info.ModTime()) > enrollStaleAfter {
				_ = os.RemoveAll(filepath.Join(root, entry.Name()))
			}
		}
	}
	return root, nil
}

func accountsAdd(ctx context.Context, cfg *config.Config, args []string, stdout, stderr io.Writer) int {
	for _, arg := range args {
		if arg == "-h" || arg == "--help" {
			fmt.Fprint(stdout, accountsUsage)
			return 0
		}
	}
	if !cfg.Host.Secure {
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", "insecure hosts cannot enroll additional accounts")
		return 1
	}
	client, _, err := accountsClient(cfg)
	if err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", err.Error())
		return 1
	}
	cli, err := claude.FindCLI()
	if err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", err.Error())
		return 127
	}
	root, err := enrollRoot()
	if err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", "login directory: "+err.Error())
		return 1
	}
	dir, err := os.MkdirTemp(root, "login-")
	if err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", "login directory: "+err.Error())
		return 1
	}
	// The private directory holds a fresh refresh token: remove it on every
	// path, including an interrupted login (the context kills the child).
	defer os.RemoveAll(dir)
	if err := os.Chmod(dir, 0o700); err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", "login directory: "+err.Error())
		return 1
	}
	ui.Say(stdout, "clx", ui.ToneOK, "accounts", "isolated Claude login; ~/.claude and running sessions stay untouched")
	cmd := exec.CommandContext(ctx, cli, append([]string{"auth", "login"}, args...)...)
	cmd.Env = claude.EnrollmentEnv(dir)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, stdout, stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() > 0 {
			ui.Say(stderr, "clx", ui.ToneFail, "accounts", "Claude login aborted")
			return exitErr.ExitCode()
		}
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", "Claude login: "+err.Error())
		return 1
	}
	payload, err := claude.EnrollmentUpload(dir)
	if err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", err.Error())
		return 1
	}
	uploadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	res, err := client.AuthEnroll(uploadCtx, payload)
	if err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "accounts", "upload: "+serverError(err))
		return 1
	}
	if res.AccountCreated {
		ui.Say(stdout, "clx", ui.ToneOK, "accounts", fmt.Sprintf("New account enrolled: #%d %s", res.AccountID, res.AccountLabel))
	} else {
		ui.Say(stdout, "clx", ui.ToneOK, "accounts", fmt.Sprintf("Existing account refreshed: #%d %s", res.AccountID, res.AccountLabel))
	}
	return 0
}
