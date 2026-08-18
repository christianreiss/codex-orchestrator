package claude

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
)

// packageManagers lists the package manager binaries the prerequisite
// bootstrap knows how to drive, tried in the same order as the bash
// installer's package_manager() (api/src/services/wrapper-transition.ts).
var packageManagers = []string{"apt-get", "dnf", "yum", "apk", "pacman", "zypper", "brew"}

// ensurePrerequisites makes a best-effort attempt to get `node` and `npm`
// onto PATH via the host's OS package manager. It exists so a host that
// enables the Claude engine after being minted without ever running the
// bash installer (e.g. a Codex-only host) can still self-heal through the
// ordinary cron/peer-reconcile path instead of failing forever with "npm
// not available on PATH". Mirrors ensure_claude_prerequisites() in
// api/src/services/wrapper-transition.ts, minus interactive UI output; the
// bash installer remains the primary path and is unaffected by this.
func ensurePrerequisites(ctx context.Context, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}
	if hasCommand("node") && hasCommand("npm") {
		return nil
	}

	if !hasCommand("node") && !hasCommand("nodejs") {
		if err := installOSPackage(ctx, "node", logger); err != nil {
			return fmt.Errorf("install Node.js: %w", err)
		}
	}
	if !hasCommand("node") && !hasCommand("nodejs") {
		return errors.New("Node.js is unavailable after install")
	}

	if !hasCommand("npm") {
		if err := installOSPackage(ctx, "npm", logger); err != nil {
			return fmt.Errorf("install npm: %w", err)
		}
	}
	if !hasCommand("npm") {
		return errors.New("npm is unavailable after install")
	}
	return nil
}

func hasCommand(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func detectPackageManager() (string, error) {
	for _, tool := range packageManagers {
		if hasCommand(tool) {
			return tool, nil
		}
	}
	return "", errors.New("no supported package manager found (tried apt-get, dnf, yum, apk, pacman, zypper, brew)")
}

// packageNamesFor mirrors the $PACKAGE_TOOL:$PACKAGE_KIND case switch in
// install_os_component() (wrapper-transition.ts).
func packageNamesFor(tool, kind string) ([]string, error) {
	switch tool + ":" + kind {
	case "apt-get:node":
		return []string{"nodejs"}, nil
	case "apt-get:npm":
		return []string{"npm"}, nil
	case "dnf:node", "yum:node", "apk:node", "pacman:node", "zypper:node":
		return []string{"nodejs"}, nil
	case "dnf:npm", "yum:npm", "apk:npm", "pacman:npm", "zypper:npm":
		return []string{"npm"}, nil
	case "brew:node", "brew:npm":
		return []string{"node"}, nil
	default:
		return nil, fmt.Errorf("no package mapping for %s on %s", kind, tool)
	}
}

func installOSPackage(ctx context.Context, kind string, logger *slog.Logger) error {
	tool, err := detectPackageManager()
	if err != nil {
		return err
	}
	names, err := packageNamesFor(tool, kind)
	if err != nil {
		return err
	}
	logger.Debug("installing OS package for Claude prerequisites", "tool", tool, "packages", names)

	switch tool {
	case "apt-get":
		env := []string{"DEBIAN_FRONTEND=noninteractive"}
		args := append([]string{"install", "-y", "--no-install-recommends"}, names...)
		if out, err := runPackageCommand(ctx, tool, env, args...); err != nil {
			// Mirror the bash fallback: refresh the package index once, then retry.
			if _, uerr := runPackageCommand(ctx, tool, nil, "update"); uerr != nil {
				return fmt.Errorf("apt-get install %s failed: %w: %s", strings.Join(names, " "), err, strings.TrimSpace(string(out)))
			}
			if out, err := runPackageCommand(ctx, tool, env, args...); err != nil {
				return fmt.Errorf("apt-get install %s failed after update: %w: %s", strings.Join(names, " "), err, strings.TrimSpace(string(out)))
			}
		}
		return nil
	case "dnf":
		args := append([]string{"install", "-y", "--setopt=install_weak_deps=False"}, names...)
		if out, err := runPackageCommand(ctx, tool, nil, args...); err != nil {
			return fmt.Errorf("dnf install %s failed: %w: %s", strings.Join(names, " "), err, strings.TrimSpace(string(out)))
		}
		return nil
	case "yum":
		args := append([]string{"install", "-y"}, names...)
		if out, err := runPackageCommand(ctx, tool, nil, args...); err != nil {
			return fmt.Errorf("yum install %s failed: %w: %s", strings.Join(names, " "), err, strings.TrimSpace(string(out)))
		}
		return nil
	case "apk":
		args := append([]string{"add", "--no-cache"}, names...)
		if out, err := runPackageCommand(ctx, tool, nil, args...); err != nil {
			return fmt.Errorf("apk add %s failed: %w: %s", strings.Join(names, " "), err, strings.TrimSpace(string(out)))
		}
		return nil
	case "pacman":
		args := append([]string{"-S", "--noconfirm", "--needed"}, names...)
		if out, err := runPackageCommand(ctx, tool, nil, args...); err != nil {
			return fmt.Errorf("pacman install %s failed: %w: %s", strings.Join(names, " "), err, strings.TrimSpace(string(out)))
		}
		return nil
	case "zypper":
		args := append([]string{"--non-interactive", "install", "--no-recommends"}, names...)
		if out, err := runPackageCommand(ctx, tool, nil, args...); err != nil {
			return fmt.Errorf("zypper install %s failed: %w: %s", strings.Join(names, " "), err, strings.TrimSpace(string(out)))
		}
		return nil
	case "brew":
		// brew refuses to run as root; never elevate it.
		out, err := exec.CommandContext(ctx, "brew", append([]string{"install"}, names...)...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("brew install %s failed: %w: %s", strings.Join(names, " "), err, strings.TrimSpace(string(out)))
		}
		return nil
	default:
		return fmt.Errorf("unsupported package manager %q", tool)
	}
}

// runPackageCommand runs a package-manager subcommand, escalating through
// `sudo -n` when the process isn't already root (mirroring run_privileged()
// in the bash installer). extraEnv entries are passed via `env` so they
// survive the sudo hop the same way `sudo env KEY=VAL cmd...` does in bash.
func runPackageCommand(ctx context.Context, tool string, extraEnv []string, args ...string) ([]byte, error) {
	name := tool
	fullArgs := args
	if len(extraEnv) > 0 {
		fullArgs = append(append([]string{}, extraEnv...), append([]string{tool}, args...)...)
		name = "env"
	}
	if os.Geteuid() != 0 {
		if _, err := exec.LookPath("sudo"); err != nil {
			return nil, fmt.Errorf("root privileges required to run %q and sudo is unavailable", tool)
		}
		fullArgs = append([]string{"-n", name}, fullArgs...)
		name = "sudo"
	}
	return exec.CommandContext(ctx, name, fullArgs...).CombinedOutput()
}
