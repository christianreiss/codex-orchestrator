// Package log centralizes slog setup for the wrapper. stdout is reserved for
// engine passthrough; structured logs go to stderr.
package log

import (
	"io"
	"log/slog"
	"os"
)

// Setup returns a logger configured for the wrapper's three-state verbosity:
//
//	(silent=false, debug=false) → WARN  (default; only warnings + errors)
//	(silent=true,  debug=false) → ERROR
//	(silent=*,     debug=true)  → DEBUG (debug wins — operator asked for it)
//
// The default is WARN, not INFO, because the wrapper's interactive boot screen
// already conveys auth/skills/agents/config state via dot tones; INFO-level
// slog text-handler output (e.g. "auth.json updated from /sync/bootstrap")
// duplicates that in a structured-log format that looks like an error to the
// user. Lifecycle code that needs to surface progress to the operator emits
// plain "cdx: …" lines to stderr instead.
func Setup(silent, debug bool) *slog.Logger {
	level := slog.LevelWarn
	switch {
	case debug:
		level = slog.LevelDebug
	case silent:
		level = slog.LevelError
	}
	var w io.Writer = os.Stderr
	handler := slog.NewTextHandler(w, &slog.HandlerOptions{Level: level})
	logger := slog.New(handler)
	slog.SetDefault(logger)
	return logger
}
