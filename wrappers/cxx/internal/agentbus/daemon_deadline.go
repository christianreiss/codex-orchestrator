package agentbus

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

func deadlineExpired(value string, now time.Time) bool {
	if value == "" {
		return false
	}
	deadline, err := time.Parse(time.RFC3339Nano, value)
	return err != nil || !now.Before(deadline)
}

// Persist the server's first-connection deadline before accepting any work.
// A disconnected daemon and a rebooted service enforce the same deadline.
func rememberDaemonDeadline(settings daemonSettings) error {
	if settings.ExpiresAt == "" {
		return nil
	}
	dir, err := daemonStateDir()
	if err != nil {
		return err
	}
	body, err := json.Marshal(settings.ExpiresAt)
	if err != nil {
		return err
	}
	return writeProtectedFile(filepath.Join(dir, "deadline.json"), body)
}

func daemonLocalExpired() bool {
	dir, err := daemonStateDir()
	if err != nil {
		return true
	}
	body, err := os.ReadFile(filepath.Join(dir, "deadline.json"))
	if os.IsNotExist(err) {
		return false
	}
	if err != nil {
		return true
	}
	var deadline string
	if json.Unmarshal(body, &deadline) != nil {
		return true
	}
	return deadlineExpired(deadline, time.Now())
}
