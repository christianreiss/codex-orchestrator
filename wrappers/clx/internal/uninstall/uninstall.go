// Package uninstall removes the clx wrapper, its config, and ~/.claude state.
//
// Engine-aware contract (clx → claude):
//
//  1. POST /host/users so the server tells us which other usernames are
//     registered on this host. Used to refuse destructive cleanup on
//     multi-user hosts when the current process has neither root nor
//     passwordless sudo.
//  2. Best-effort DELETE /auth?force=1&engine=claude — server-side
//     de-registration.
//  3. Remove ~/.claude artefacts (settings.json, CLAUDE.md, .credentials.json),
//     the clx-native tree (~/.clx/), wrapper config
//     (~/.config/codex-orchestrator/clx.json{,.sig}), and the npm-global
//     @anthropic-ai/claude-code package when detected.
//  4. Drop the managed cron entry via cron.Remove.
//
// Every removed target prints one line on stdout. Missing paths are silent.
package uninstall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
)

// collectionDirs maps the on-disk manifest name to the ~/.claude subdir holding
// fleet-written collection files (kept in lock-step with lifecycle/collections.go).
var collectionDirs = map[string]string{"agents": "agents", "commands": "commands", "output-styles": "output-styles"}

// removeFleetCollections deletes only the collection files the fleet wrote, per
// the manifests under ~/.clx/state/collections/. Must run BEFORE ~/.clx is
// removed (that drops the manifests). User-authored files are never touched.
func removeFleetCollections(home string, stdout, stderr io.Writer) {
	for manName, sub := range collectionDirs {
		manPath := filepath.Join(home, ".clx", "state", "collections", manName+".json")
		raw, err := os.ReadFile(manPath)
		if err != nil {
			continue
		}
		var man struct {
			Items map[string]struct {
				Filename string `json:"filename"`
			} `json:"items"`
		}
		if err := json.Unmarshal(raw, &man); err != nil {
			continue
		}
		for _, rec := range man.Items {
			if rec.Filename == "" {
				continue
			}
			removeReport(stdout, stderr, filepath.Join(home, ".claude", sub, rec.Filename))
		}
	}
}

type hostUsersResponse struct {
	Users []hostUser `json:"users"`
	Data  struct {
		Users []hostUser `json:"users"`
	} `json:"data"`
}

type hostUser struct {
	Username string `json:"username"`
	Hostname string `json:"hostname"`
}

func (r *hostUsersResponse) merged() []hostUser {
	if len(r.Users) > 0 {
		return r.Users
	}
	return r.Data.Users
}

func Run(ctx context.Context, cfg *config.Config, stdout, stderr io.Writer) error {
	client, clientErr := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})

	currentUsername := currentUser()
	var others []string
	if clientErr == nil {
		others = otherUsers(ctx, client, currentUsername)
	}
	if len(others) > 0 {
		if err := ensureCanDestructivelyTouchOtherUsers(stderr, others); err != nil {
			return err
		}
	}

	if clientErr == nil {
		req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, cfg.Orchestrator.BaseURL+"/auth?force=1&engine=claude", nil)
		resp, derr := client.Do(ctx, req, 0)
		if derr != nil {
			fmt.Fprintln(stderr, "uninstall: server-side delete failed (best-effort):", derr)
		} else {
			resp.Body.Close()
			fmt.Fprintf(stdout, "uninstall: server-side delete -> HTTP %d\n", resp.StatusCode)
		}
	}

	home, _ := os.UserHomeDir()
	targets := []string{
		filepath.Join(home, ".claude", "settings.json"),
		filepath.Join(home, ".claude", "CLAUDE.md"),
		filepath.Join(home, ".claude", ".credentials.json"),
		filepath.Join(home, ".config", "codex-orchestrator", "clx.json"),
		filepath.Join(home, ".config", "codex-orchestrator", "clx.json.sig"),
	}
	for _, p := range targets {
		removeReport(stdout, stderr, p)
	}

	// Remove fleet-written collection files (subagents/commands/output-styles)
	// before dropping ~/.clx, which holds the manifests that locate them.
	removeFleetCollections(home, stdout, stderr)

	// Drop the entire clx-native tree (auth/, config/, cache).
	clxDir := filepath.Join(home, ".clx")
	if _, err := os.Stat(clxDir); err == nil {
		if err := os.RemoveAll(clxDir); err != nil {
			fmt.Fprintln(stderr, "uninstall: remove", clxDir, ":", err)
		} else {
			fmt.Fprintln(stdout, "uninstall: removed", clxDir)
		}
	}

	if npmGlobalHas("@anthropic-ai/claude-code") {
		cmd := exec.CommandContext(ctx, "npm", "uninstall", "-g", "@anthropic-ai/claude-code")
		if err := cmd.Run(); err != nil {
			fmt.Fprintln(stderr, "uninstall: npm uninstall -g @anthropic-ai/claude-code:", err)
		} else {
			fmt.Fprintln(stdout, "uninstall: removed npm-global @anthropic-ai/claude-code")
		}
	}

	if err := cron.Remove(); err != nil {
		fmt.Fprintln(stderr, "uninstall: cron.Remove:", err)
	} else {
		fmt.Fprintln(stdout, "uninstall: removed managed crontab entry")
	}

	return nil
}

func otherUsers(ctx context.Context, client *orchestrator.Client, currentUsername string) []string {
	hostname, _ := os.Hostname()
	body := map[string]any{
		"username": currentUsername,
		"hostname": hostname,
	}
	var resp hostUsersResponse
	if err := client.JSON(ctx, http.MethodPost, "/host/users", body, &resp, 0); err != nil {
		return nil
	}
	seen := map[string]struct{}{}
	out := []string{}
	for _, u := range resp.merged() {
		name := u.Username
		if name == "" || name == currentUsername {
			continue
		}
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out
}

func ensureCanDestructivelyTouchOtherUsers(stderr io.Writer, others []string) error {
	if os.Geteuid() == 0 {
		return nil
	}
	if sudoWorksNonInteractively() {
		return nil
	}
	fmt.Fprintf(stderr,
		"clx --uninstall refused: host has registered users besides this one (%v) "+
			"but the process is not root and `sudo -n true` is unavailable.\n"+
			"Rerun as root or with passwordless sudo so the cleanup can touch every user's state.\n",
		others)
	return errors.New("uninstall refused: multi-user host without root/sudo")
}

func sudoWorksNonInteractively() bool {
	cmd := exec.Command("sudo", "-n", "true")
	return cmd.Run() == nil
}

func currentUser() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	return os.Getenv("USER")
}

func npmGlobalHas(pkg string) bool {
	if _, err := exec.LookPath("npm"); err != nil {
		return false
	}
	cmd := exec.Command("npm", "ls", "-g", "--depth=0", pkg)
	return cmd.Run() == nil
}

func removeReport(stdout, stderr io.Writer, p string) {
	err := os.Remove(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return
		}
		fmt.Fprintln(stderr, "uninstall: remove", p, ":", err)
		return
	}
	fmt.Fprintln(stdout, "uninstall: removed", p)
}
