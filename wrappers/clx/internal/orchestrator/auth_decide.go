// Package orchestrator — auth_decide.go contains the launch-gate decision
// table that maps every (auth status, local-file, host-secure) tuple to a
// typed AuthDecision. Mirrors wrappers/cdx/internal/orchestrator/auth_decide.go
// 1:1; reasons are engine-neutral.
package orchestrator

import (
	"strings"
	"time"
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

	case "disabled":
		d.Reason = "Auth API disabled by administrator."
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
