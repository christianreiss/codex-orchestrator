// Package cron manages the cdx auto-update crontab entry. The legacy bash
// wrapper installed an entry like:
//
//	37 2 * * * /usr/local/bin/cdx --cron >> ~/.codex/cron.log 2>&1 # cdx-managed-cron
//
// The minute (0-59) and hour (0-3) are derived deterministically from the
// hostname so all hosts don't hit the orchestrator at once.
package cron

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"hash/crc32"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
)

const marker = "# cdx-managed-cron"

// Install writes a fresh crontab line (replacing any existing managed entry).
func Install() error {
	cur, _ := readCrontab()
	lines := stripManaged(cur)
	bin, err := os.Executable()
	if err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	logFile := filepath.Join(home, ".codex", "cron.log")
	host, _ := os.Hostname()
	min, hr := deterministicTime(host)
	entry := fmt.Sprintf("%d %d * * * %s --cron run >> %s 2>&1 %s", min, hr, bin, logFile, marker)
	lines = append(lines, entry)
	return writeCrontab(strings.Join(lines, "\n") + "\n")
}

// Remove drops any managed entry from the crontab.
func Remove() error {
	cur, err := readCrontab()
	if err != nil {
		return err
	}
	lines := stripManaged(cur)
	body := strings.Join(lines, "\n")
	if body != "" {
		body += "\n"
	}
	return writeCrontab(body)
}

// Tick is the action taken by `cdx --cron run`. It checks the orchestrator,
// applies any wrapper/Codex updates, and reports back.
func Tick(ctx context.Context, cfg *config.Config) error {
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		return err
	}
	// Hit /sync/status for a cheap probe so the server records the cron tick.
	_, err = client.SyncStatus(ctx)
	return err
}

func deterministicTime(host string) (min, hr int) {
	if host == "" {
		host = "unknown"
	}
	sum := crc32.ChecksumIEEE([]byte(host))
	min = int(sum % 60)
	hr = int((sum / 60) % 4) // 0..3
	return
}

func readCrontab() (string, error) {
	cmd := exec.Command("crontab", "-l")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &bytes.Buffer{}
	if err := cmd.Run(); err != nil {
		// Empty crontab is fine.
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return "", nil
		}
		return "", err
	}
	return out.String(), nil
}

func writeCrontab(body string) error {
	cmd := exec.Command("crontab", "-")
	cmd.Stdin = strings.NewReader(body)
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func stripManaged(s string) []string {
	out := []string{}
	for _, line := range strings.Split(s, "\n") {
		if strings.Contains(line, marker) {
			continue
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		out = append(out, line)
	}
	return out
}
