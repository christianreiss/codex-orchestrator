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
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
)

// collectionDirs maps the on-disk manifest name to the ~/.claude subdir holding
// fleet-written collection files (kept in lock-step with lifecycle/collections.go).
var collectionDirs = map[string]string{"agents": "agents", "commands": "commands", "output-styles": "output-styles"}

const probeTimeout = 5 * time.Second

// Indirected so privilege-gate tests never probe the host's real sudo policy.
var (
	effectiveUID = os.Geteuid
	sudoProbe    = sudoWorksNonInteractively
)

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
			if rec.Filename == "" || rec.Filename == "." || rec.Filename == ".." || rec.Filename != filepath.Base(rec.Filename) {
				continue
			}
			_ = removeReport(stdout, stderr, filepath.Join(home, ".claude", sub, rec.Filename))
		}
	}
}

// removeFleetSkills deletes the fleet-written skill directories per the
// ~/.clx/state/collections/skills.json manifest. Each skill is a directory
// (skills/<slug>/SKILL.md), so we RemoveAll the slug dir. User-authored skill
// dirs (never in our manifest) are untouched. Must run BEFORE ~/.clx is removed.
func removeFleetSkills(home string, stdout, stderr io.Writer) {
	manPath := filepath.Join(home, ".clx", "state", "collections", "skills.json")
	raw, err := os.ReadFile(manPath)
	if err != nil {
		return
	}
	var man struct {
		Items map[string]struct {
			Filename string `json:"filename"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &man); err != nil {
		return
	}
	for _, rec := range man.Items {
		sub := filepath.Dir(rec.Filename)
		if sub == "." || sub == "" || sub == ".." || sub != filepath.Base(sub) {
			continue
		}
		d := filepath.Join(home, ".claude", "skills", sub)
		if err := os.RemoveAll(d); err != nil && !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(stderr, "uninstall: remove", d, ":", err)
			continue
		}
		fmt.Fprintln(stdout, "uninstall: removed", d)
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
	maintenance, err := claude.AcquireAuthMaintenance()
	if err != nil {
		return fmt.Errorf("uninstall: acquire exclusive auth maintenance lease: %w", err)
	}
	defer maintenance.Close() //nolint:errcheck

	client, clientErr := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})

	currentUsername := currentUser()
	if clientErr != nil {
		if err := requireRootOrSudo(ctx, stderr, "the multi-user safety check could not run (orchestrator client init failed)"); err != nil {
			return err
		}
	} else {
		others, lookupErr := otherUsersOrErr(ctx, client, currentUsername)
		if lookupErr != nil {
			if err := requireRootOrSudo(ctx, stderr, "the multi-user safety check could not run (host lookup failed)"); err != nil {
				return err
			}
		} else if len(others) > 0 {
			if err := ensureCanDestructivelyTouchOtherUsers(ctx, stderr, others); err != nil {
				return err
			}
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
	} else {
		fmt.Fprintln(stderr, "uninstall: server-side delete skipped (best-effort):", clientErr)
	}

	home, homeErr := os.UserHomeDir()
	if homeErr != nil {
		return fmt.Errorf("uninstall: cannot resolve home directory: %w", homeErr)
	}
	localCleanupErr := removeLocalState(home, stdout, stderr)

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

	return localCleanupErr
}

func removeLocalState(home string, stdout, stderr io.Writer) error {
	var cleanupErr error
	targets := []string{
		filepath.Join(home, ".claude", "settings.json"),
		filepath.Join(home, ".claude", "CLAUDE.md"),
		filepath.Join(home, ".claude", ".credentials.json"),
		filepath.Join(home, ".config", "codex-orchestrator", "clx.json"),
		filepath.Join(home, ".config", "codex-orchestrator", "clx.json.sig"),
	}
	for _, p := range targets {
		cleanupErr = errors.Join(cleanupErr, removeReport(stdout, stderr, p))
	}

	// Remove fleet-written collection files (subagents/commands/output-styles)
	// before dropping ~/.clx, which holds the manifests that locate them.
	removeFleetCollections(home, stdout, stderr)
	removeFleetSkills(home, stdout, stderr)

	// Drop the entire clx-native tree (auth/, config/, cache).
	clxDir := filepath.Join(home, ".clx")
	if _, err := os.Stat(clxDir); err == nil {
		if err := os.RemoveAll(clxDir); err != nil {
			fmt.Fprintln(stderr, "uninstall: remove", clxDir, ":", err)
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("remove %s: %w", clxDir, err))
		} else {
			fmt.Fprintln(stdout, "uninstall: removed", clxDir)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		cleanupErr = errors.Join(cleanupErr, fmt.Errorf("inspect %s: %w", clxDir, err))
	}
	return cleanupErr
}

func otherUsers(ctx context.Context, client *orchestrator.Client, currentUsername string) []string {
	out, _ := otherUsersOrErr(ctx, client, currentUsername)
	return out
}

func otherUsersOrErr(ctx context.Context, client *orchestrator.Client, currentUsername string) ([]string, error) {
	hostname, _ := os.Hostname()
	body := map[string]any{
		"username": currentUsername,
		"hostname": hostname,
	}
	var resp hostUsersResponse
	if err := client.JSON(ctx, http.MethodPost, "/host/users", body, &resp, 0); err != nil {
		return nil, err
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
	return out, nil
}

func ensureCanDestructivelyTouchOtherUsers(ctx context.Context, stderr io.Writer, others []string) error {
	return requireRootOrSudo(ctx, stderr, fmt.Sprintf("host has registered users besides this one (%v)", others))
}

func requireRootOrSudo(ctx context.Context, stderr io.Writer, reason string) error {
	if effectiveUID() == 0 {
		return nil
	}
	if sudoProbe(ctx) {
		return nil
	}
	fmt.Fprintf(stderr,
		"clx --uninstall refused: %s "+
			"but the process is not root and `sudo -n true` is unavailable.\n"+
			"Rerun as root or with passwordless sudo so the cleanup can touch every user's state.\n",
		reason)
	return errors.New("uninstall refused: multi-user host without root/sudo")
}

func sudoWorksNonInteractively(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sudo", "-n", "true")
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

func removeReport(stdout, stderr io.Writer, p string) error {
	err := os.Remove(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		fmt.Fprintln(stderr, "uninstall: remove", p, ":", err)
		return fmt.Errorf("remove %s: %w", p, err)
	}
	fmt.Fprintln(stdout, "uninstall: removed", p)
	return nil
}
