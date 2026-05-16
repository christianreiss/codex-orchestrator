// Package log centralizes slog setup for the wrapper. stdout is reserved for
// engine passthrough; structured logs go to stderr.
package log

import (
	"io"
	"log/slog"
	"os"
)

// Setup returns a logger configured for either silent or normal output.
// In silent mode only Errors go through; in normal mode Info+ are logged.
func Setup(silent bool) *slog.Logger {
	level := slog.LevelInfo
	if silent {
		level = slog.LevelError
	}
	var w io.Writer = os.Stderr
	handler := slog.NewTextHandler(w, &slog.HandlerOptions{Level: level})
	logger := slog.New(handler)
	slog.SetDefault(logger)
	return logger
}
