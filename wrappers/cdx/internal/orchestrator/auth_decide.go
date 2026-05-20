// Package orchestrator — auth_decide.go contains the launch-gate decision
// table that maps every (auth status, local-file, host-secure) tuple to a
// typed AuthDecision. Behavioural source of truth is the legacy bash block at
// fe70ac3:bin/cdx.d/05-main-46-entry.sh "AUTH_LAUNCH_ALLOWED" switch.
//
// The decision struct is consumed by lifecycle.Run; it intentionally carries
// the raw status string back so the boot screen and exit footer can render
// it without re-deriving.
package orchestrator

import (
	"strings"
	"time"
)

// AuthDecision is the typed gate output. Allowed=true means lifecycle.Run
// proceeds to spawn Codex; otherwise lifecycle.Run prints Reason and exits
// non-zero. NeedsApprovalPoll asks the caller to render the insecure-approval
// status box and re-bundle on resolution.
type AuthDecision struct {
	Allowed           bool
	Status            string // echoed back, lower-cased
	Reason            string // human-facing refusal text
	NeedsApprovalPoll bool   // true if status == "insecure"
	LocalUsable       bool   // true if we fell back to cached auth
}

// LocalAuthProbe is the callback shape the decision engine uses to consult
// the local auth.json. Splitting these as functions keeps orchestrator/ free
// of any direct import on internal/codex (which depends on orchestrator/ via
// doctor.go).
//
//   - IsValid: structural check (matches legacy validate_auth_json_file).
//   - IsFresh: returns true if last_refresh is within `window`.
//
// Either may be nil — callers that don't care about offline fallback can
// pass an empty LocalAuthProbe.
type LocalAuthProbe struct {
	IsValid func(path string) bool
	IsFresh func(path string, window time.Duration) (bool, error)
}

// MaxLocalAuthAge mirrors legacy MAX_LOCAL_AUTH_AGE_SECONDS (general).
const MaxLocalAuthAge = 24 * time.Hour

// MaxLocalAuthRecent mirrors legacy MAX_LOCAL_AUTH_RECENT_SECONDS
// (secure-host stretch window).
const MaxLocalAuthRecent = 7 * 24 * time.Hour

// Decide returns the launch decision for a given auth-retrieve response. If
// the caller had a network/timeout error from AuthRetrieve and wants to
// attempt the offline fallback, it should synthesise a response with
// Status="offline" and Message=<original error string>.
//
//   - localAuthPath: absolute path to auth.json on disk; "" disables local
//     freshness checks.
//   - hostSecure:    true when the host is in the secure cohort (allowed to
//     stretch the cached window to 7 days).
//   - probe: optional callbacks to inspect local auth.json. Can be a zero
//     value; offline + concurrent fallbacks then refuse.
func Decide(resp *AuthRetrieveResponse, localAuthPath string, hostSecure bool, probe LocalAuthProbe) AuthDecision {
	d := AuthDecision{}
	if resp == nil {
		d.Reason = "Auth unavailable; refusing to start Codex."
		return d
	}
	status := strings.ToLower(strings.TrimSpace(resp.Status))
	d.Status = status

	// Server-side kill-switch trumps every other state.
	if resp.Versions != nil && resp.Versions.APIDisabled {
		d.Reason = "Auth API disabled by administrator."
		return d
	}
	// Installation-ID mismatch is a security stop; the server signals it via
	// a deny message that contains the literal "installation_id" token.
	if strings.Contains(strings.ToLower(resp.Message), "installation_id") {
		d.Reason = "Installation ID mismatch; refusing to sync."
		return d
	}
	// Reverse-DNS mismatch: the server resolved the caller's IP to a hostname
	// that does not match the registered FQDN. Surface the reason explicitly so
	// operators can diagnose split-horizon DNS or NAT setups without digging
	// through server logs.
	if strings.Contains(strings.ToLower(resp.Message), "reverse_dns") ||
		strings.Contains(strings.ToLower(resp.Message), "reverse dns") {
		d.Reason = "reverse DNS mismatch; refusing to sync."
		return d
	}

	switch status {
	case "valid", "current", "ok", "unchanged", "updated", "outdated":
		d.Allowed = true
		return d

	case "missing", "upload_required":
		// Caller (lifecycle.Run) is expected to read local auth and upload
		// via /sync/bootstrap auth_candidate. Launch allowed informationally.
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
		// Read-only mode: another instance holds the lock. Launch is only
		// allowed if the local file is structurally usable so Codex doesn't
		// crash mid-boot looking for tokens.
		if localAuthPath != "" && probe.IsValid != nil && probe.IsValid(localAuthPath) {
			d.Allowed = true
			d.LocalUsable = true
			return d
		}
		d.Reason = "Active cdx run detected and local auth.json is invalid or absent."
		return d

	case "offline", "":
		// Offline branch: network/timeout error during AuthRetrieve. Allow
		// launch from cached auth as long as the file is fresh per windows.
		// Secure hosts stretch to 7d (legacy MAX_LOCAL_AUTH_RECENT_SECONDS).
		if localAuthPath == "" || probe.IsFresh == nil {
			d.Reason = "Auth API offline and no cached auth.json."
			return d
		}
		fresh, _ := probe.IsFresh(localAuthPath, MaxLocalAuthAge)
		if fresh {
			d.Allowed = true
			d.LocalUsable = true
			d.Reason = "API offline; using cached auth.json."
			return d
		}
		if hostSecure {
			fresh7, _ := probe.IsFresh(localAuthPath, MaxLocalAuthRecent)
			if fresh7 {
				d.Allowed = true
				d.LocalUsable = true
				d.Reason = "API offline; secure host using cached auth.json."
				return d
			}
		}
		d.Reason = "API offline and cached auth.json older than allowed window."
		return d
	}

	// Unrecognised status — refuse with a stable message rather than letting
	// it through (a future server-side status change should be a deliberate
	// wrapper update, not a silent launch).
	d.Reason = "Unknown auth status " + status + "; refusing to start Codex."
	return d
}
