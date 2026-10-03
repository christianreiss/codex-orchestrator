// Package orchestrator — auth_decide.go contains the launch-gate decision
// table that maps every (auth status, local-file, host-secure) tuple to a
// typed AuthDecision for the Claude persona.
// 1:1; reasons are engine-neutral.
package orchestrator

import (
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// AuthDecision is the typed launch-gate output.
type AuthDecision struct {
	Allowed           bool
	Status            string
	Reason            string
	NeedsApprovalPoll bool
	LocalUsable       bool
}

// LocalAuthProbe lets the decision engine consult the local credentials file
// without importing internal/claude (which already imports this package).
type LocalAuthProbe struct {
	IsValid func(path string) bool
	IsFresh func(path string, window time.Duration) (bool, error)
}

const (
	MaxLocalAuthAge    = 24 * time.Hour
	MaxLocalAuthRecent = 7 * 24 * time.Hour
)

// Decide returns the launch decision for an auth-retrieve response.
//
// Caller-supplied offline sentinel: synthesise Status="offline" and
// Message=<error string> when AuthRetrieve itself failed; Decide then
// considers the local-auth freshness windows.
func Decide(resp *AuthRetrieveResponse, localAuthPath string, hostSecure bool, probe LocalAuthProbe) AuthDecision {
	d := AuthDecision{}
	if resp == nil {
		d.Reason = "Auth unavailable; refusing to start Claude Code."
		return d
	}
	status := strings.ToLower(strings.TrimSpace(resp.Status))
	d.Status = status

	if resp.Versions != nil && resp.Versions.APIDisabled {
		d.Reason = "Auth API disabled by administrator."
		return d
	}
	if strings.Contains(strings.ToLower(resp.Message), "installation_id") {
		d.Reason = "Installation ID mismatch; refusing to sync."
		return d
	}
	// Reverse-DNS mismatch: the server resolved the caller's IP to a hostname
	// that does not match the registered FQDN. Surface the reason explicitly so
	// operators can diagnose split-horizon DNS or NAT setups without digging
	// through server logs. The rejection arrives as an HTTP error whose body
	// (carrying the reverse_dns code) is threaded into resp.Message via the
	// offline sentinel, so this fires before the offline launch-from-cache path.
	if strings.Contains(strings.ToLower(resp.Message), "reverse_dns") ||
		strings.Contains(strings.ToLower(resp.Message), "reverse dns") {
		d.Reason = "reverse DNS mismatch; refusing to sync."
		return d
	}
	// Static IP-binding mismatch: /sync/bootstrap represents the 401 body as an
	// offline sentinel. This is a reachable API policy denial, not an outage;
	// never fall back to cached credentials, even when they are still fresh.
	if strings.Contains(strings.ToLower(resp.Message), "ip_mismatch") {
		d.Reason = "IP binding mismatch (ip_mismatch; API is reachable): this host's current IP is not bound. In Admin → Host Detail, use Release IP binding for a controlled IP change, then retry."
		return d
	}
	// Engine disabled, by the fleet-wide master switch ("suspended") or by
	// removal from this host's assignment ("disabled"). The non-bundle /auth
	// path and the /sync/bootstrap path both synthesize those statuses from
	// the 403; the Message sniff below remains for a body folded into an
	// offline sentinel. Either way this is a reachable policy refusal and must
	// never fall through to the offline launch-from-cache path.
	if scope, disabled := engineDisabledScope(resp); disabled {
		d.Status = AuthStatusDisabled
		if scope == config.EngineDisabledScopeFleet {
			d.Status = AuthStatusSuspended
		}
		d.Reason = config.EngineDisabledMessage(config.EngineClaude, scope)
		return d
	}

	// Live launch-gate proof: when the server reached Anthropic and the canonical
	// credentials did NOT authenticate, refuse the managed launch instead of
	// dropping the user into a raw 401 / "Please run /login" inside Claude. The
	// server only emits "failed" when the runner reached the provider, so a local
	// cached-credentials fallback would 401 too — re-login is the only fix.
	if strings.EqualFold(strings.TrimSpace(resp.VerificationState), "failed") {
		d.Reason = "Claude credentials failed live verification (login expired). Re-authenticate with `claude` → `/login`, then re-run clx."
		return d
	}

	switch status {
	case "valid", "current", "ok", "unchanged", "updated", "outdated":
		d.Allowed = true
		return d

	case "missing", "upload_required":
		d.Allowed = true
		d.Reason = "Local auth missing or upload required; will upload."
		return d

	case "invalid":
		d.Reason = "Invalid API key; download a fresh wrapper or rotate the key."
		return d

	case "insecure":
		d.NeedsApprovalPoll = true
		d.Reason = "Insecure host approval pending; open the host window in the admin dashboard."
		return d

	case "insecure-denied":
		d.Reason = "Insecure host approval denied; re-run or open the host window."
		return d

	case "concurrent":
		if localAuthPath != "" && probe.IsValid != nil && probe.IsValid(localAuthPath) {
			d.Allowed = true
			d.LocalUsable = true
			return d
		}
		d.Reason = "Active clx run detected and local credentials are invalid or absent."
		return d

	case "offline", "":
		if localAuthPath == "" || probe.IsFresh == nil {
			d.Reason = "Auth API offline and no cached credentials."
			return d
		}
		fresh, _ := probe.IsFresh(localAuthPath, MaxLocalAuthAge)
		if fresh {
			d.Allowed = true
			d.LocalUsable = true
			d.Reason = "API offline; using cached credentials."
			return d
		}
		if hostSecure {
			fresh7, _ := probe.IsFresh(localAuthPath, MaxLocalAuthRecent)
			if fresh7 {
				d.Allowed = true
				d.LocalUsable = true
				d.Reason = "API offline; secure host using cached credentials."
				return d
			}
		}
		d.Reason = "API offline and cached credentials older than allowed window."
		return d

	case "error":
		// Server-side processing error (e.g. runner verification gate). Treat
		// like offline: fall back to local credentials if fresh, else refuse.
		if localAuthPath != "" && probe.IsFresh != nil {
			fresh, _ := probe.IsFresh(localAuthPath, MaxLocalAuthAge)
			if fresh {
				d.Allowed = true
				d.LocalUsable = true
				d.Reason = "Server error; using cached credentials."
				return d
			}
		}
		msg := resp.Message
		if msg == "" {
			msg = "server returned an error"
		}
		d.Reason = "Auth server error: " + msg + "; no usable cached credentials."
		return d
	}

	d.Reason = "Unknown auth status " + status + "; refusing to start Claude Code."
	return d
}

// ApplyConcurrent adjusts a base decision for a sync-paused secondary run.
// Auth freshness stays active even though managed resource/update writes pause.
// It never upgrades a refusal; it only refuses an otherwise-allowed launch when
// the current local Claude credentials file is not structurally usable.
func ApplyConcurrent(dec AuthDecision, localAuthPath string, probe LocalAuthProbe) AuthDecision {
	if !dec.Allowed {
		return dec
	}
	if localAuthPath != "" && probe.IsValid != nil && probe.IsValid(localAuthPath) {
		dec.LocalUsable = true
		return dec
	}
	dec.Allowed = false
	dec.Reason = "Active clx run detected and local credentials are invalid or absent."
	return dec
}

// engineDisabledScope reports whether resp carries an engine_disabled refusal
// and its scope. The typed statuses win; a raw 403 body folded into Message
// (an offline sentinel built from the transport error) is sniffed as a
// fallback, and a body without a scope keeps its historical host meaning.
func engineDisabledScope(resp *AuthRetrieveResponse) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(resp.Status)) {
	case AuthStatusSuspended:
		return config.EngineDisabledScopeFleet, true
	case AuthStatusDisabled:
		return config.EngineDisabledScopeHost, true
	}
	message := resp.Message
	if !strings.Contains(strings.ToLower(message), "engine_disabled") {
		return "", false
	}
	if start := strings.Index(message, "{"); start >= 0 {
		if scope := parseErrorScope([]byte(message[start:])); scope == config.EngineDisabledScopeFleet {
			return config.EngineDisabledScopeFleet, true
		}
	}
	compact := strings.Join(strings.Fields(strings.ToLower(message)), "")
	if strings.Contains(compact, `"scope":"fleet"`) {
		return config.EngineDisabledScopeFleet, true
	}
	return config.EngineDisabledScopeHost, true
}
