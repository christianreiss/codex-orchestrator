// Package uninstall removes the wrapper, its config, and ~/.codex state.
//
// Engine-aware contract (cdx → codex):
//
//  1. POST /host/users so the server tells us which other usernames are
//     registered on this host. The legacy bash wrapper used this to refuse
//     destructive cleanup on multi-user hosts when the current process has
//     neither root nor passwordless sudo.
//  2. Best-effort DELETE /auth?force=1 — server-side de-registration.
//  3. Remove ~/.codex artefacts (auth.json, AGENTS.md, config.toml), wrapper
//     config (~/.config/codex-orchestrator/cdx.json{,.sig}), /opt/codex when
//     writable, and the npm-global codex-cli package when detected.
//  4. Drop the managed cron entry via cron.Remove (importable here — uninstall
//     never re-enters lifecycle, so no circular dep risk).
//
// Every removed target prints one line on stdout. Missing paths are silent.
package uninstall

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
)

// hostUsersResponse models POST /host/users. The envelope plugin spreads the
// `{users}` payload to both the root and a nested `data` block, so accept
// either shape for forward/back compatibility with the bash wrapper.
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

// Run performs an uninstall. Errors are surfaced for fatal issues only — every
// per-target removal is best-effort and logged inline.
func Run(ctx context.Context, cfg *config.Config, stdout, stderr io.Writer) error {
	client, clientErr := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})

	// (1) Learn about other registered users on this host. Failure here is
	// non-fatal — we just lose the safety net for multi-user hosts.
	var others []string
	currentUsername := currentUser()
	if clientErr == nil {
		others = otherUsers(ctx, client, currentUsername)
	}
	if len(others) > 0 {
		if err := ensureCanDestructivelyTouchOtherUsers(stderr, others); err != nil {
			return err
		}
	}

	// (2) Best-effort server-side delete (force=1 to bypass any "host has
	// other users" guard the server may apply).
	if clientErr == nil {
		req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, cfg.Orchestrator.BaseURL+"/auth?force=1", nil)
		resp, derr := client.Do(ctx, req, 0)
		if derr != nil {
			fmt.Fprintln(stderr, "uninstall: server-side delete failed (best-effort):", derr)
		} else {
			resp.Body.Close()
			fmt.Fprintf(stdout, "uninstall: server-side delete -> HTTP %d\n", resp.StatusCode)
		}
	}

	// (3) Remove local state.
	home, _ := os.UserHomeDir()
	targets := []string{
		filepath.Join(home, ".codex", "auth.json"),
		filepath.Join(home, ".codex", "AGENTS.md"),
		filepath.Join(home, ".codex", "config.toml"),
		filepath.Join(home, ".config", "codex-orchestrator", "cdx.json"),
		filepath.Join(home, ".config", "codex-orchestrator", "cdx.json.sig"),
	}
	for _, p := range targets {
		removeReport(stdout, stderr, p)
	}

	// /opt/codex — only attempt when writable to avoid clobbering a
	// system-managed install when the operator runs cdx as themselves.
	if optWritable("/opt/codex") {
		if err := os.RemoveAll("/opt/codex"); err != nil {
			fmt.Fprintln(stderr, "uninstall: remove /opt/codex:", err)
		} else {
			fmt.Fprintln(stdout, "uninstall: removed /opt/codex")
		}
	}

	// npm-global codex-cli when detected.
	if npmGlobalHas("codex-cli") {
		cmd := exec.CommandContext(ctx, "npm", "uninstall", "-g", "codex-cli")
		if err := cmd.Run(); err != nil {
			fmt.Fprintln(stderr, "uninstall: npm uninstall -g codex-cli:", err)
		} else {
			fmt.Fprintln(stdout, "uninstall: removed npm-global codex-cli")
		}
	}

	// (4) Drop the managed cron entry. Best-effort.
	if err := cron.Remove(); err != nil {
		fmt.Fprintln(stderr, "uninstall: cron.Remove:", err)
	} else {
		fmt.Fprintln(stdout, "uninstall: removed managed crontab entry")
	}

	return nil
}

// otherUsers calls POST /host/users with the current username/hostname and
// returns every other registered username. Network failures collapse to an
// empty slice so the safety stop only fires when the server actually reports
// a multi-user host.
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

// ensureCanDestructivelyTouchOtherUsers refuses the uninstall when other users
// are registered and the current process has neither root privileges nor a
// passwordless sudo path. Mirrors the legacy bash safety stop.
func ensureCanDestructivelyTouchOtherUsers(stderr io.Writer, others []string) error {
	if os.Geteuid() == 0 {
		return nil
	}
	if sudoWorksNonInteractively() {
		return nil
	}
	fmt.Fprintf(stderr,
		"cdx --uninstall refused: host has registered users besides this one (%v) "+
			"but the process is not root and `sudo -n true` is unavailable.\n"+
			"Rerun as root or with passwordless sudo so the cleanup can touch every user's state.\n",
		others)
	return errors.New("uninstall refused: multi-user host without root/sudo")
}

func sudoWorksNonInteractively() bool {
	// `sudo -n true` exits 0 only when sudo can run without prompting.
	cmd := exec.Command("sudo", "-n", "true")
	return cmd.Run() == nil
}

func currentUser() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	return os.Getenv("USER")
}

func optWritable(p string) bool {
	info, err := os.Stat(p)
	if err != nil {
		return false
	}
	if !info.IsDir() {
		return false
	}
	// Probe writability by attempting to create a temp file inside.
	probe, err := os.CreateTemp(p, ".cdx-uninstall-*")
	if err != nil {
		return false
	}
	name := probe.Name()
	probe.Close()
	_ = os.Remove(name)
	return true
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
