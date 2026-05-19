package log

import (
	"io"
	"log/slog"
	"os"
)

// Setup mirrors the cdx-side three-state verbosity:
//
//	(silent=false, debug=false) → WARN  (default; only warnings + errors)
//	(silent=true,  debug=false) → ERROR
//	(silent=*,     debug=true)  → DEBUG (debug wins)
//
// See wrappers/cdx/internal/log/log.go for the rationale.
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
