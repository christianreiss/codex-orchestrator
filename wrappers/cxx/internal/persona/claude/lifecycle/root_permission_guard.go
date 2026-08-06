package lifecycle

// Claude Code refuses to start when the resolved permission mode is
// `bypassPermissions` and the process is running as root or under sudo:
//
//	--dangerously-skip-permissions cannot be used with root/sudo privileges
//	for security reasons
//
// The check is deliberate upstream and has no supported override. So that
// combination never yields a permissive agent -- it yields one that cannot
// launch, and on the relay path the failure is invisible: the peer dies before
// it can report anything and its delivery goes terminally `ambiguous`, which
// reads exactly like a peer that chose not to answer.
//
// The orchestrator already declines to serve that combination (a root host is
// baked `auto` instead). This is the second layer, and it exists because the
// server has to trust a username the wrapper sent it, while here the uid is a
// fact. It covers the cases the bake-time clamp structurally cannot: a
// hand-edited settings.json, a host still pinned to an older orchestrator, and
// a root account whose username is not literally "root".
//
// `auto` rather than a stricter mode: it is what upstream recommends in place of
// a bypass, and it is the only substitute that leaves an unattended run able to
// act -- reads and working-directory edits are auto-approved and everything else
// is vetted by a classifier instead of a prompt nobody is there to answer.

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

const (
	rootGuardMode       = "auto"
	rootGuardRefuseMode = "bypassPermissions"
	permissionModeFlag  = "--permission-mode"
)

// effectiveUID is a test seam, mirroring the one in the uninstall package.
var effectiveUID = os.Geteuid

// guardRootPermissionMode returns the argv to launch with, substituting a
// startable permission mode when the configured one would abort the process.
//
// It never rewrites settings.json: the fleet owns that file, and racing it here
// would make the two disagree on every sync. A per-run flag outranks the file
// and leaves ownership intact.
func guardRootPermissionMode(args []string, logger *slog.Logger) []string {
	if effectiveUID() != 0 {
		return args
	}
	// An explicit choice by whoever invoked us wins; they may be deliberately
	// asking for a mode we would not have picked.
	if hasPermissionModeFlag(args) {
		return args
	}
	if configuredPermissionMode() != rootGuardRefuseMode {
		return args
	}
	if logger != nil {
		logger.Warn(
			"permission mode is not startable as root; launching with a mode that is",
			"configured", rootGuardRefuseMode,
			"using", rootGuardMode,
			"reason", "claude refuses --dangerously-skip-permissions under root/sudo",
		)
	}
	// Prepend: these are global options, and a subcommand may follow in ExtraArgs.
	return append([]string{permissionModeFlag, rootGuardMode}, args...)
}

func hasPermissionModeFlag(args []string) bool {
	for _, a := range args {
		if a == permissionModeFlag || strings.HasPrefix(a, permissionModeFlag+"=") {
			return true
		}
	}
	return false
}

// configuredPermissionMode reads permissions.defaultMode out of the user
// settings file, the same file `clx doctor` reports on. An unreadable or absent
// file yields "", which means the guard stays out of the way -- a launch that
// was going to work must not be altered because we could not parse something.
func configuredPermissionMode() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return ""
	}
	var doc struct {
		Permissions struct {
			DefaultMode string `json:"defaultMode"`
		} `json:"permissions"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return ""
	}
	return strings.TrimSpace(doc.Permissions.DefaultMode)
}
