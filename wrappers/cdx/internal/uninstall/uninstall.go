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
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
)

// probeTimeout bounds the sudo/npm probe subprocesses so a hung PAM plugin or
// stalled npm registry lookup can't wedge cdx --uninstall indefinitely.
const probeTimeout = 5 * time.Second

// Indirected so privilege-gate tests never probe the host's real sudo policy.
var (
	effectiveUID = os.Geteuid
	sudoProbe    = sudoWorksNonInteractively
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
func Run(ctx context.Context, cfg *config.Config, stdout, stderr io.Writer) (runErr error) {
	maintenance, err := codex.TryAcquireAuthMaintenance()
	if err != nil {
		if errors.Is(err, ipc.ErrHeld) {
			return errors.New("uninstall refused: another cdx process is using this Codex home")
		}
		return fmt.Errorf("uninstall: acquire auth maintenance lease: %w", err)
	}
	defer func() {
		runErr = errors.Join(runErr, maintenance.Release())
	}()

	client, clientErr := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})

	// (1) Learn about other registered users on this host. If the safety-net
	// query itself can't be answered (client construction failed, or the
	// /host/users call errored), fail closed: require root/passwordless sudo
	// rather than silently assuming there are no other users.
	currentUsername := currentUser()
	if clientErr != nil {
		if err := requireRootOrSudo(ctx, stderr, "the multi-user safety check could not run (orchestrator client init failed)"); err != nil {
			return err
		}
	} else {
		others, err := otherUsersOrErr(ctx, client, currentUsername)
		if err != nil {
			if err := requireRootOrSudo(ctx, stderr, "the multi-user safety check could not run (host lookup failed)"); err != nil {
				return err
			}
		} else if len(others) > 0 {
			if err := ensureCanDestructivelyTouchOtherUsers(ctx, stderr, others); err != nil {
				return err
			}
		}
	}

	// (2) Best-effort server-side delete (force=1 to bypass any "host has
	// other users" guard the server may apply).
	if clientErr == nil {
		req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, cfg.Orchestrator.BaseURL+authDeletePath(), nil)
		resp, derr := client.Do(ctx, req, 0)
		if derr != nil {
			fmt.Fprintln(stderr, "uninstall: server-side delete failed (best-effort):", derr)
		} else {
			resp.Body.Close()
			fmt.Fprintf(stdout, "uninstall: server-side delete -> HTTP %d\n", resp.StatusCode)
		}
	}

	// (3) Remove local state.
	home, homeErr := os.UserHomeDir()
	if homeErr != nil || home == "" {
		if u, uerr := user.Current(); uerr == nil && u.HomeDir != "" {
			home = u.HomeDir
		} else {
			return fmt.Errorf("uninstall: could not determine home directory: %w", homeErr)
		}
	}
	codexHome, codexHomeErr := codex.CodexHome()
	if codexHomeErr != nil {
		return fmt.Errorf("uninstall: could not determine Codex home: %w", codexHomeErr)
	}
	authTargets := requiredAuthStateTargets(codexHome)
	requiredCleanupErr := removeRequiredAuthState(stdout, stderr, authTargets)
	targets := []string{
		filepath.Join(codexHome, ".cdx-auth.lock"),
		filepath.Join(codexHome, "AGENTS.md"),
		filepath.Join(codexHome, "config.toml"),
		filepath.Join(home, ".config", "codex-orchestrator", "cdx.json"),
		filepath.Join(home, ".config", "codex-orchestrator", "cdx.json.sig"),
	}
	for _, p := range targets {
		_ = removeReport(stdout, stderr, p)
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
	if npmGlobalHas(ctx, "codex-cli") {
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

	return requiredCleanupErr
}

func requiredAuthStateTargets(codexHome string) []string {
	return []string{
		filepath.Join(codexHome, "auth.json"),
		filepath.Join(codexHome, ".cdx-logout-intent.json"),
		filepath.Join(codexHome, ".cdx-insecure-purge-request"),
		filepath.Join(codexHome, ".cdx-canonical-auth-generations.json"),
	}
}

func authDeletePath() string {
	return "/auth?force=1&engine=codex"
}

// otherUsers calls POST /host/users with the current username/hostname and
// returns every other registered username. Network/JSON failures collapse to
// an empty slice — kept for compatibility with callers that only need the
// best-effort result. Run uses otherUsersOrErr instead so it can fail closed
// on error rather than silently treating a failed lookup as "no other users".
func otherUsers(ctx context.Context, client *orchestrator.Client, currentUsername string) []string {
	out, _ := otherUsersOrErr(ctx, client, currentUsername)
	return out
}

// otherUsersOrErr is otherUsers but propagates the transport/JSON error
// instead of swallowing it, so the safety-net check can distinguish "no other
// users" from "couldn't ask".
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

// ensureCanDestructivelyTouchOtherUsers refuses the uninstall when other users
// are registered and the current process has neither root privileges nor a
// passwordless sudo path. Mirrors the legacy bash safety stop.
func ensureCanDestructivelyTouchOtherUsers(ctx context.Context, stderr io.Writer, others []string) error {
	return requireRootOrSudo(ctx, stderr, fmt.Sprintf("host has registered users besides this one (%v)", others))
}

// requireRootOrSudo refuses the uninstall unless the current process is root
// or has passwordless sudo, printing reason as the justification.
func requireRootOrSudo(ctx context.Context, stderr io.Writer, reason string) error {
	if effectiveUID() == 0 {
		return nil
	}
	if sudoProbe(ctx) {
		return nil
	}
	fmt.Fprintf(stderr,
		"cdx --uninstall refused: %s "+
			"but the process is not root and `sudo -n true` is unavailable.\n"+
			"Rerun as root or with passwordless sudo so the cleanup can touch every user's state.\n",
		reason)
	return errors.New("uninstall refused: multi-user host without root/sudo")
}

func sudoWorksNonInteractively(ctx context.Context) bool {
	// `sudo -n true` exits 0 only when sudo can run without prompting.
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

func npmGlobalHas(ctx context.Context, pkg string) bool {
	if _, err := exec.LookPath("npm"); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "npm", "ls", "-g", "--depth=0", pkg)
	return cmd.Run() == nil
}

func removeReport(stdout, stderr io.Writer, p string) error {
	err := os.Remove(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		fmt.Fprintln(stderr, "uninstall: remove", p, ":", err)
		return err
	}
	fmt.Fprintln(stdout, "uninstall: removed", p)
	return nil
}

func removeRequiredAuthState(stdout, stderr io.Writer, targets []string) error {
	var joined error
	for _, path := range targets {
		if err := removeReport(stdout, stderr, path); err != nil {
			joined = errors.Join(joined, fmt.Errorf("remove required auth state %s: %w", path, err))
		}
	}
	return joined
}
