package log

import (
	"io"
	"log/slog"
	"os"
)

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
