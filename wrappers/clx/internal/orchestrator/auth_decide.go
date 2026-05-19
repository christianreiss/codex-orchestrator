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
	}

	d.Reason = "Unknown auth status " + status + "; refusing to start Claude Code."
	return d
}
