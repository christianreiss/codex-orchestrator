package quotaadvice

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type DayChoice struct {
	Engine    string    `json:"engine"`
	Instance  string    `json:"instance"`
	ExpiresAt time.Time `json:"expires_at"`
}

func instanceKey(instance string) string {
	digest := sha256.Sum256([]byte(strings.TrimRight(instance, "/")))
	return hex.EncodeToString(digest[:])
}
func StatePath(instance string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "codex-orchestrator", "quota-choices", instanceKey(instance)+".json"), nil
}
func LoadChoice(path, instance string, now time.Time) *DayChoice {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var choice DayChoice
	if json.Unmarshal(data, &choice) != nil || (choice.Engine != "codex" && choice.Engine != "claude") || choice.Instance != instanceKey(instance) || !choice.ExpiresAt.After(now) || choice.ExpiresAt.After(nextMidnight(now)) {
		return nil
	}
	return &choice
}
func nextMidnight(now time.Time) time.Time {
	return time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, now.Location())
}
func SaveChoice(path, instance, engine string, now time.Time) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(DayChoice{Engine: engine, Instance: instanceKey(instance), ExpiresAt: nextMidnight(now)})
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".choice-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
func ClearChoice(path string) error {
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
