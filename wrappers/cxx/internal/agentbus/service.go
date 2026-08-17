package agentbus

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

const (
	serviceName = "cxx-agent"
	launchLabel = "net.alpha-labs.cxx-agent"
)

var (
	managedServiceProcess = runServiceProcess
	systemdUnitMissing    = detectSystemdUnitMissing
	launchdUnitMissing    = detectLaunchdUnitMissing
	serviceLookPath       = exec.LookPath
	serviceUserName       = currentUserName
)

func renderSystemdUserUnit(executable, binaryDigest string, environment map[string]string) string {
	var environmentLines strings.Builder
	for _, key := range []string{"CDX_CONFIG_PATH", "CLX_CONFIG_PATH"} {
		if value := strings.TrimSpace(environment[key]); value != "" {
			environmentLines.WriteString("Environment=" + systemdQuote(key+"="+value) + "\n")
		}
	}
	return `[Unit]
Description=Codex Orchestrator background worker
# CXXBinarySHA256=` + binaryDigest + `
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
` + environmentLines.String() + `ExecStart=` + systemdQuote(executable) + ` agent worker --foreground
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=default.target
`
}

func renderLaunchAgent(executable, binaryDigest string, environment map[string]string) string {
	var environmentXML strings.Builder
	for _, key := range []string{"CDX_CONFIG_PATH", "CLX_CONFIG_PATH"} {
		if value := strings.TrimSpace(environment[key]); value != "" {
			environmentXML.WriteString("    <key>" + key + "</key><string>" + html.EscapeString(value) + "</string>\n")
		}
	}
	environmentBlock := ""
	if environmentXML.Len() > 0 {
		environmentBlock = "  <key>EnvironmentVariables</key><dict>\n" + environmentXML.String() + "  </dict>\n"
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- CXXBinarySHA256=` + binaryDigest + ` -->
<plist version="1.0"><dict>
  <key>Label</key><string>` + launchLabel + `</string>
  <key>ProgramArguments</key><array>
    <string>` + html.EscapeString(executable) + `</string>
    <string>agent</string><string>worker</string><string>--foreground</string>
  </array>
` + environmentBlock + `  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`
}

func runServiceCommand(args []string, stdout, stderr io.Writer) error {
	if len(args) != 1 {
		return errors.New("service action must be install, remove, start, stop, restart, or status")
	}
	action := args[0]
	if action == "status" {
		status, err := serviceStatus()
		if err != nil {
			return err
		}
		return writeJSON(stdout, status)
	}
	if action != "install" && action != "remove" && action != "start" && action != "stop" && action != "restart" {
		return fmt.Errorf("unknown service action %q", action)
	}
	if runtime.GOOS == "linux" {
		return runSystemdAction(action, stdout, stderr)
	}
	if runtime.GOOS == "darwin" {
		return runLaunchdAction(action, stdout, stderr)
	}
	return fmt.Errorf("background agent service is unsupported on %s; use cxx agent worker --foreground", runtime.GOOS)
}

// RemoveService removes the managed per-user worker during a confirmed
// last-engine uninstall. It is exported for the shared uninstall coordinator;
// partial or unconfirmed engine removals deliberately leave it in place.
func RemoveService(stdout, stderr io.Writer) error {
	if err := runServiceCommand([]string{"remove"}, stdout, stderr); err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	return os.RemoveAll(filepath.Join(home, ".cxx", "agent"))
}

// EnsureService installs and starts the managed background worker idempotently.
func EnsureService(stdout, stderr io.Writer) error {
	return runServiceCommand([]string{"install"}, stdout, stderr)
}

func serviceStatus() (map[string]any, error) {
	status := map[string]any{"platform": runtime.GOOS, "installed": false, "active": false}
	path, err := servicePath()
	if err != nil {
		return status, err
	}
	if _, statErr := os.Stat(path); statErr == nil {
		status["installed"] = true
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return status, statErr
	}
	status["path"] = path
	var cmd *exec.Cmd
	if runtime.GOOS == "linux" {
		cmd = systemdUserCommand("--user", "is-active", "--quiet", serviceName+".service")
	} else if runtime.GOOS == "darwin" {
		cmd = exec.Command("launchctl", "print", fmt.Sprintf("gui/%d/%s", os.Getuid(), launchLabel))
	} else {
		status["supported"] = false
		return status, nil
	}
	status["supported"] = true
	status["active"] = cmd.Run() == nil
	return status, nil
}

func runSystemdAction(action string, stdout, stderr io.Writer) error {
	path, err := servicePath()
	if err != nil {
		return err
	}
	unit := serviceName + ".service"
	switch action {
	case "install":
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		binaryDigest, err := fileSHA256(exe)
		if err != nil {
			return err
		}
		environment, err := serviceConfigEnvironment()
		if err != nil {
			return err
		}
		unitBody := []byte(renderSystemdUserUnit(exe, binaryDigest, environment))
		unitChanged, err := writeProtectedFileIfChanged(path, unitBody)
		if err != nil {
			return err
		}
		enableSystemdLinger(stdout, stderr)
		if err := managedServiceProcess(stdout, stderr, "systemctl", "--user", "daemon-reload"); err != nil {
			return err
		}
		if err := managedServiceProcess(stdout, stderr, "systemctl", "--user", "enable", unit); err != nil {
			return err
		}
		deploymentID := serviceDeploymentID(binaryDigest, unitBody)
		deployed := serviceDeploymentMatches(deploymentID)
		// `systemctl start` is a no-op for an already-active unit, so the daily
		// cron ensure cannot interrupt an in-flight native delivery.
		action := "start"
		if unitChanged || !deployed {
			// `enable --now` does not restart an already-running process after
			// the cxx binary or unit changes. restart also starts an inactive unit.
			action = "restart"
		}
		if err := managedServiceProcess(stdout, stderr, "systemctl", "--user", action, unit); err != nil {
			return err
		}
		if unitChanged || !deployed {
			return recordServiceDeployment(deploymentID)
		}
		return nil
	case "remove":
		if stopErr := managedServiceProcess(stdout, stderr, "systemctl", "--user", "disable", "--now", unit); stopErr != nil {
			missing, probeErr := systemdUnitMissing(unit)
			if probeErr != nil || !missing {
				return errors.Join(stopErr, probeErr)
			}
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return managedServiceProcess(stdout, stderr, "systemctl", "--user", "daemon-reload")
	default:
		return managedServiceProcess(stdout, stderr, "systemctl", "--user", action, unit)
	}
}

func runLaunchdAction(action string, stdout, stderr io.Writer) error {
	path, err := servicePath()
	if err != nil {
		return err
	}
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	target := domain + "/" + launchLabel
	switch action {
	case "install":
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		binaryDigest, err := fileSHA256(exe)
		if err != nil {
			return err
		}
		environment, err := serviceConfigEnvironment()
		if err != nil {
			return err
		}
		plistBody := []byte(renderLaunchAgent(exe, binaryDigest, environment))
		plistChanged, err := writeProtectedFileIfChanged(path, plistBody)
		if err != nil {
			return err
		}
		deploymentID := serviceDeploymentID(binaryDigest, plistBody)
		deployed := serviceDeploymentMatches(deploymentID)
		if plistChanged || !deployed {
			if stopErr := managedServiceProcess(stdout, stderr, "launchctl", "bootout", target); stopErr != nil {
				missing, probeErr := launchdUnitMissing(target)
				if probeErr != nil || !missing {
					return errors.Join(stopErr, probeErr)
				}
			}
			if err := managedServiceProcess(stdout, stderr, "launchctl", "bootstrap", domain, path); err != nil {
				return err
			}
			return recordServiceDeployment(deploymentID)
		}
		// Without -k, kickstart leaves an already-running job in place. This is
		// the non-disruptive path used by the daily cron ensure.
		if err := managedServiceProcess(stdout, stderr, "launchctl", "kickstart", target); err != nil {
			missing, probeErr := launchdUnitMissing(target)
			if probeErr != nil || !missing {
				return errors.Join(err, probeErr)
			}
			return managedServiceProcess(stdout, stderr, "launchctl", "bootstrap", domain, path)
		}
		return nil
	case "remove":
		if stopErr := managedServiceProcess(stdout, stderr, "launchctl", "bootout", target); stopErr != nil {
			missing, probeErr := launchdUnitMissing(target)
			if probeErr != nil || !missing {
				return errors.Join(stopErr, probeErr)
			}
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	case "start":
		return managedServiceProcess(stdout, stderr, "launchctl", "kickstart", target)
	case "stop":
		return managedServiceProcess(stdout, stderr, "launchctl", "kill", "SIGTERM", target)
	case "restart":
		return managedServiceProcess(stdout, stderr, "launchctl", "kickstart", "-k", target)
	default:
		return fmt.Errorf("unsupported launchd action %q", action)
	}
}

func servicePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "LaunchAgents", launchLabel+".plist"), nil
	}
	if runtime.GOOS == "linux" {
		configHome := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME"))
		if configHome == "" {
			configHome = filepath.Join(home, ".config")
		}
		return filepath.Join(configHome, "systemd", "user", serviceName+".service"), nil
	}
	return "", fmt.Errorf("unsupported service platform %s", runtime.GOOS)
}

func writeProtectedFile(path string, body []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".cxx-agent-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func writeProtectedFileIfChanged(path string, body []byte) (bool, error) {
	existing, err := os.ReadFile(path)
	if err == nil && bytes.Equal(existing, body) {
		if chmodErr := os.Chmod(path, 0o600); chmodErr != nil {
			return false, chmodErr
		}
		return false, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := writeProtectedFile(path, body); err != nil {
		return false, err
	}
	return true, nil
}

// A systemd --user unit lives inside the user's manager, which logind tears
// down with their last login session unless lingering is enabled. Without it
// the worker stops seconds after whichever session installed it goes away, so
// neither agent messages nor detached Claude auth rotations are handled.
//
// Best effort on purpose. A container without logind has no loginctl, and an
// unprivileged user can be refused by polkit; neither should fail the install,
// because a relay that runs while someone is logged in still beats none. The
// failure is printed rather than swallowed: a silent one is exactly what let
// this hide.
func enableSystemdLinger(stdout, stderr io.Writer) {
	if _, err := serviceLookPath("loginctl"); err != nil {
		return
	}
	name := serviceUserName()
	if name == "" {
		return
	}
	if err := managedServiceProcess(stdout, stderr, "loginctl", "enable-linger", name); err != nil {
		fmt.Fprintf(stderr, "cxx agent: could not enable systemd lingering for %s: %v\n", name, err)
		fmt.Fprintf(stderr, "cxx agent: the background worker will stop when this user's last login session ends; run 'loginctl enable-linger %s' as root for unattended operation\n", name)
	}
}

func currentUserName() string {
	if current, err := user.Current(); err == nil {
		if name := strings.TrimSpace(current.Username); name != "" {
			return name
		}
	}
	for _, key := range []string{"USER", "LOGNAME"} {
		if name := strings.TrimSpace(os.Getenv(key)); name != "" {
			return name
		}
	}
	return ""
}

func runServiceProcess(stdout, stderr io.Writer, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if runtime.GOOS == "linux" && name == "systemctl" && len(args) > 0 && args[0] == "--user" {
		cmd.Env = systemdUserEnvironment(os.Environ(), os.Getuid())
	}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return nil
}

func serviceConfigEnvironment() (map[string]string, error) {
	environment := make(map[string]string, 2)
	for _, item := range []struct {
		key    string
		engine string
	}{
		{key: "CDX_CONFIG_PATH", engine: config.EngineCodex},
		{key: "CLX_CONFIG_PATH", engine: config.EngineClaude},
	} {
		path, err := config.DefaultPathForEngine(item.engine)
		if err != nil {
			return nil, err
		}
		path, err = filepath.Abs(path)
		if err != nil {
			return nil, fmt.Errorf("resolve %s: %w", item.key, err)
		}
		if strings.ContainsAny(path, "\x00\r\n") {
			return nil, fmt.Errorf("%s contains an invalid character", item.key)
		}
		environment[item.key] = path
	}
	return environment, nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open service executable: %w", err)
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", fmt.Errorf("hash service executable: %w", err)
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func serviceDeploymentID(binaryDigest string, serviceBody []byte) string {
	digest := sha256.New()
	_, _ = io.WriteString(digest, binaryDigest)
	_, _ = digest.Write([]byte{0})
	_, _ = digest.Write(serviceBody)
	return hex.EncodeToString(digest.Sum(nil))
}

func serviceDeploymentMarkerPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cxx", "agent", "service-deployment"), nil
}

func serviceDeploymentMatches(deploymentID string) bool {
	path, err := serviceDeploymentMarkerPath()
	if err != nil {
		return false
	}
	raw, err := os.ReadFile(path)
	return err == nil && strings.TrimSpace(string(raw)) == deploymentID
}

func recordServiceDeployment(deploymentID string) error {
	path, err := serviceDeploymentMarkerPath()
	if err != nil {
		return err
	}
	return writeProtectedFile(path, []byte(deploymentID+"\n"))
}

func detectSystemdUnitMissing(unit string) (bool, error) {
	cmd := systemdUserCommand("--user", "show", "--property=LoadState", "--value", unit)
	raw, err := cmd.Output()
	if err != nil {
		return false, fmt.Errorf("probe systemd unit %s: %w", unit, err)
	}
	return strings.TrimSpace(string(raw)) == "not-found", nil
}

// systemdUserCommand makes systemctl --user usable from cron and other
// headless contexts. Those processes commonly lack the session variables that
// systemctl needs even though the lingering per-user manager and its bus are
// alive under /run/user/<uid>.
func systemdUserCommand(args ...string) *exec.Cmd {
	cmd := exec.Command("systemctl", args...)
	cmd.Env = systemdUserEnvironment(os.Environ(), os.Getuid())
	return cmd
}

func systemdUserEnvironment(environment []string, uid int) []string {
	runtimeDir := fmt.Sprintf("/run/user/%d", uid)
	environment = setDefaultEnvironment(environment, "XDG_RUNTIME_DIR", runtimeDir)
	return setDefaultEnvironment(environment, "DBUS_SESSION_BUS_ADDRESS", "unix:path="+runtimeDir+"/bus")
}

func setDefaultEnvironment(environment []string, key, fallback string) []string {
	prefix := key + "="
	value := ""
	filtered := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		if strings.HasPrefix(entry, prefix) {
			if candidate := strings.TrimSpace(strings.TrimPrefix(entry, prefix)); candidate != "" {
				value = candidate
			}
			continue
		}
		filtered = append(filtered, entry)
	}
	if value == "" {
		value = fallback
	}
	return append(filtered, prefix+value)
}

func detectLaunchdUnitMissing(target string) (bool, error) {
	cmd := exec.Command("launchctl", "print", target)
	raw, err := cmd.CombinedOutput()
	if err == nil {
		return false, nil
	}
	text := strings.ToLower(string(raw))
	if strings.Contains(text, "could not find service") || strings.Contains(text, "service cannot be found") {
		return true, nil
	}
	return false, fmt.Errorf("probe launchd unit %s: %w", target, err)
}

func systemdQuote(path string) string {
	escaped := strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`).Replace(path)
	return `"` + escaped + `"`
}
