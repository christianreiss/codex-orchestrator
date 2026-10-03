package grok

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	hostcron "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/cron"
	hostmaintenance "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/maintenance"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

// cronCommand mirrors `cdx cron [install|remove|run]`: install and remove
// manage the host-wide schedule; run is the coordinator, or this engine's tick
// when the coordinator spawned it.
func cronCommand(ctx context.Context, cfg *config.Config, client *orchestrator.Client, o options, stdout, stderr io.Writer) int {
	action := "run"
	if len(o.args) > 0 {
		action = o.args[0]
	}
	switch action {
	case "install":
		if err := hostcron.Install(ctx, cfg); err != nil {
			fmt.Fprintln(stderr, "cgx cron install:", err)
			return 1
		}
		terminalui.Say(stdout, "cgx", terminalui.ToneOK, "cron", "installed")
		return 0
	case "remove":
		if err := hostcron.Remove(ctx); err != nil {
			fmt.Fprintln(stderr, "cgx cron remove:", err)
			return 1
		}
		terminalui.Say(stdout, "cgx", terminalui.ToneOK, "cron", "removed")
		return 0
	case "run":
		if !hostcron.IsEngineOnly() {
			if err := hostcron.Run(ctx, cfg, o.minimal, stdout, stderr); err != nil {
				fmt.Fprintln(stderr, "cgx cron:", err)
				return 1
			}
			return 0
		}
		// The coordinator already skips a suspended engine; this keeps any
		// other caller of the engine-only tick from updating or syncing it.
		if cfg.EngineSuspended(config.EngineGrok) {
			fmt.Fprintln(stdout, "cron: grok suspended fleet-wide; skipping maintenance tick")
			return 0
		}
		if err := maintenance(ctx, cfg, client, false, stdout, stderr); err != nil {
			fmt.Fprintln(stderr, "cgx cron:", err)
			return 1
		}
		return 0
	default:
		fmt.Fprintln(stderr, "cgx cron: unknown action:", action)
		fmt.Fprintln(stderr, "usage: cgx cron [install|remove|run]")
		return 2
	}
}

// isHelpPassthrough reports a help request for the native CLI (`cgx --help`,
// `cgx help`, `cgx mcp --help`). It must not lease an account, sync, or start
// a private runtime: argv goes straight to the native binary.
func isHelpPassthrough(args []string) bool {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			return false
		}
		if arg == "--help" || arg == "-h" || (i == 0 && arg == "help") {
			return true
		}
		if nativeTakesValue(arg) {
			i++ // an option value (prompt, path) is data, never a help flag
		}
	}
	return false
}

// grokAuthChecker adapts the shared client to the insecure-host approval box.
// Any answer other than "still waiting" resolves the poll; the launch then
// re-reads /auth and reports the real outcome (approved, denied, or an auth
// error such as a required login) instead of polling forever.
type grokAuthChecker struct{ client *orchestrator.Client }

func (c grokAuthChecker) CheckAuthStatus(ctx context.Context) (string, string, error) {
	var out startupAuth
	err := c.client.JSON(ctx, http.MethodPost, "/auth", map[string]any{"engine": "grok", "command": "retrieve"}, &out, 0)
	if status := orchestrator.InsecureStatusFromError(err); status != "" {
		return status, "", nil
	}
	var httpErr *orchestrator.HTTPError
	if errors.As(err, &httpErr) {
		return "error", httpErr.Code, nil
	}
	if err != nil {
		return "", "", err
	}
	return strings.ToLower(strings.TrimSpace(out.Status)), "", nil
}

// pollApproval is replaceable in tests; the real box needs a terminal.
var pollApproval = terminalui.PollApprovalFor("cgx")

// retrieveStartupAuth reads Grok's /auth status. An insecure host waiting for
// operator approval enters the same approval box as cdx/clx when interactive;
// headless launches refuse with the actionable instruction instead of hanging.
func retrieveStartupAuth(ctx context.Context, client *orchestrator.Client, headless, minimal bool, stderr io.Writer) (startupAuth, error) {
	var auth startupAuth
	err := client.JSON(ctx, http.MethodPost, "/auth", map[string]any{"engine": "grok", "command": "retrieve"}, &auth, 0)
	switch orchestrator.InsecureStatusFromError(err) {
	case "":
		return auth, err
	case "insecure-denied":
		return auth, errors.New("insecure host approval was denied; ask an operator to open this host's window in Admin → Host Detail")
	}
	if headless || !isTerminal(stderr) {
		return auth, errors.New("insecure host approval is required; open Admin → Host Detail, then retry")
	}
	resolved, pollErr := pollApproval(ctx, grokAuthChecker{client: client}, 5*time.Second, minimal)
	if pollErr != nil && !errors.Is(pollErr, context.Canceled) {
		return auth, pollErr
	}
	if !resolved {
		return auth, errors.New("insecure host approval is still pending")
	}
	auth = startupAuth{}
	err = client.JSON(ctx, http.MethodPost, "/auth", map[string]any{"engine": "grok", "command": "retrieve"}, &auth, 0)
	if status := orchestrator.InsecureStatusFromError(err); status != "" {
		return auth, errors.New("insecure host approval is still pending")
	}
	return auth, err
}

func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

var requestMaintenanceNow = hostmaintenance.RequestNow

// apiDisabledReason is the refusal for the orchestrator-wide API kill switch,
// worded exactly as cdx/clx word it.
const apiDisabledReason = "Auth API disabled by administrator."

// launchRefusal maps an orchestrator answer that must refuse a Grok launch to
// the operator-facing text: engine_disabled by scope (fleet master switch or
// host removal), the API kill switch, and — when the signed config says Grok
// is switched off fleet-wide — any failure that is not a server answer, so an
// outage can never route around the switch. Other errors return nil and keep
// their existing handling.
func launchRefusal(cfg *config.Config, err error) error {
	if err == nil {
		return nil
	}
	if scope, disabled := orchestrator.EngineDisabledScope(err); disabled {
		return errors.New(config.EngineDisabledMessage(config.EngineGrok, scope))
	}
	var httpErr *orchestrator.HTTPError
	answered := errors.As(err, &httpErr)
	if answered && strings.EqualFold(strings.TrimSpace(httpErr.Code), "api_disabled") {
		return errors.New(apiDisabledReason)
	}
	if cfg.EngineSuspended(config.EngineGrok) && unanswered(err, httpErr) {
		return errors.New(config.FleetDisabledMessage(config.EngineGrok))
	}
	return nil
}

// unanswered reports a failure that carries no authoritative server answer: a
// transport error, a timeout, or a 5xx. Policy answers (4xx, including the
// insecure-approval outcomes) are answers and keep their own wording.
func unanswered(err error, httpErr *orchestrator.HTTPError) bool {
	if httpErr != nil {
		return httpErr.StatusCode >= http.StatusInternalServerError
	}
	var urlErr *url.Error
	return errors.As(err, &urlErr) || errors.Is(err, context.DeadlineExceeded)
}

// reconcileEngineDrift forces background maintenance past its cooldown when
// the server's engine set differs from the baked one (cdx parity), so an engine
// an operator enabled or disabled is provisioned on this launch rather than on
// the next scheduled tick.
//
// It is called only after /auth answered for Grok, which the server refuses
// while Grok is switched off fleet-wide: a signed config that still says
// suspended is therefore stale (the switch is back on) and also refreshes now.
func reconcileEngineDrift(cfg *config.Config, auth startupAuth, client *orchestrator.Client) bool {
	if cfg == nil || !grokEngineDrift(cfg, auth) {
		return false
	}
	if err := requestMaintenanceNow(config.EngineGrok, cfg.SourcePath()); err != nil {
		warn(client, "engine-change maintenance request deferred", err)
		return false
	}
	return true
}

func grokEngineDrift(cfg *config.Config, auth startupAuth) bool {
	if cfg.EngineSuspended(config.EngineGrok) {
		return true
	}
	if auth.Host == nil {
		return false
	}
	remote := auth.Host.EnginesList
	if len(remote) == 0 && auth.Host.Engines != "" {
		remote = strings.Split(auth.Host.Engines, ",")
	}
	if len(remote) > 0 && config.EngineDrift(config.EnabledEngines(cfg.Host, config.EngineGrok), remote) {
		return true
	}
	return auth.Host.FleetDisabledEngines != nil && config.SuspensionDrift(cfg.Host.FleetDisabledEngines, auth.Host.FleetDisabledEngines)
}
