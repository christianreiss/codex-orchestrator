package grok

import (
	"io"
	"os"
	"path/filepath"
)

const leaderLogLimit = 1 << 20

// LeaderLog keeps background tracing off the native TUI's terminal. Each run
// owns a private file, so concurrent leaders cannot overwrite one another.
// On overflow a new chunk replaces the old one, bounding the file to 1 MiB.
type LeaderLog struct {
	file *os.File
	size int
}

func OpenLeaderLog(stateDir string) (*LeaderLog, error) {
	dir := filepath.Join(stateDir, "leader-logs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(dir, "grok-*.log")
	if err != nil {
		return nil, err
	}
	return &LeaderLog{file: f}, nil
}

func (l *LeaderLog) Path() string { return l.file.Name() }
func (l *LeaderLog) Close() error { return l.file.Close() }

func (l *LeaderLog) Write(p []byte) (int, error) {
	n := len(p)
	if len(p) > leaderLogLimit {
		p = p[len(p)-leaderLogLimit:]
	}
	if l.size+len(p) > leaderLogLimit {
		if err := l.file.Truncate(0); err != nil {
			return 0, err
		}
		if _, err := l.file.Seek(0, io.SeekStart); err != nil {
			return 0, err
		}
		l.size = 0
	}
	written, err := l.file.Write(p)
	l.size += written
	if err != nil {
		return 0, err
	}
	return n, nil
}
