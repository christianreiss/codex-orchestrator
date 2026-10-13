package agentbus

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

type ResidentRunner func(context.Context, string) error

func RunResidentServiceCommand(args []string, stdout, stderr io.Writer, version string, runner ResidentRunner) int {
	if runtime.GOOS != "linux" {
		fmt.Fprintln(stderr, "resident service requires Linux/systemd")
		return 1
	}
	if len(args) != 1 {
		fmt.Fprintln(stderr, "usage: cxx communicator install|status|start|stop|uninstall|run|rollback")
		return 2
	}
	if args[0] == "rollback" {
		if err := rollbackResidentService(stdout, stderr); err != nil {
			fmt.Fprintln(stderr, "resident rollback:", err)
			return 1
		}
		return 0
	}
	if args[0] != "run" {
		return RunDaemonCommand(args, stdout, stderr, version)
	}
	_, seed, err := loadResidentConfigs()
	if err == nil && seed.Orchestrator.CommunicatorRuntimeProtocol != residency.Protocol {
		return RunDaemonCommand(args, stdout, stderr, version)
	}
	if err == nil && runner == nil {
		err = errors.New("resident communicator runner unavailable")
	}
	if err == nil {
		err = runner(context.Background(), seed.SourcePath())
	}
	if err != nil {
		fmt.Fprintln(stderr, "resident communicator:", err)
		return 1
	}
	return 0
}

func loadResidentConfigs() (map[string]*config.Config, *config.Config, error) {
	key, err := signing.PublicKey()
	if err != nil {
		return nil, nil, err
	}
	configs := map[string]*config.Config{}
	var seed *config.Config
	for _, engine := range []string{"codex", "claude", "grok"} {
		path, err := config.DefaultPathForEngine(engine)
		if err != nil {
			continue
		}
		cfg, err := config.LoadForEngine(path, key, false, engine)
		if err != nil || cfg.EngineSuspended(engine) {
			continue
		}
		if seed == nil {
			seed = cfg
		}
		if cfg.Host.ID != seed.Host.ID || cfg.Host.FQDN != seed.Host.FQDN || cfg.Orchestrator.BaseURL != seed.Orchestrator.BaseURL || cfg.Orchestrator.InstallationID != seed.Orchestrator.InstallationID {
			return nil, nil, errors.New("resident engine configs belong to different host identities")
		}
		configs[engine] = cfg
	}
	if seed == nil {
		return nil, nil, errors.New("no active signed engine config available for residence")
	}
	return configs, seed, nil
}

func OpenDirectResidentDaemon(ctx context.Context, base string) (residency.DaemonStream, error) {
	_, seed, err := loadMessagingConfigs()
	if err != nil {
		return nil, err
	}
	if seed == nil || seed.Orchestrator.BaseURL != base {
		return nil, errors.New("resident execution identity unavailable")
	}
	client, err := newRelayClient(seed)
	if err != nil {
		return nil, err
	}
	ws, err := dialDirectDaemonConnection(ctx, client)
	if err != nil {
		return nil, err
	}
	ws.MaxPayloadBytes = 2 * 1024 * 1024
	return websocketDaemonStream{ws}, nil
}

func residentRequested(settings daemonSettings, runtimeEnabled bool) bool {
	execution := settings.Enabled || runtimeEnabled && settings.ExecutionRequested
	return runtimeEnabled && settings.ResidentEnabled || execution && !deadlineExpired(settings.ExpiresAt, time.Now())
}

// Unit environment belongs to the configured OS user; roots imported from a
// different login are not silently assigned to this service's namespace.
func residentConfigurationEnabled() bool {
	_, seed, err := loadResidentConfigs()
	return err == nil && seed.Orchestrator.CommunicatorRuntimeProtocol == residency.Protocol
}

func serviceMainPID() (int, error) {
	out, err := exec.Command("systemctl", "show", "--property=MainPID", "--value", "cxx-daemon.service").Output()
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || pid < 0 {
		return 0, errors.New("invalid systemd process identity")
	}
	return pid, nil
}

// Until the complete identity-validated handoff is ready, never replace a
// service that may own accepted work. Inactive/fresh services remain installable.
func guardResidentReplacement() error {
	pid, err := serviceMainPID()
	if err != nil {
		return fmt.Errorf("resident migration pending: cannot verify service process: %w", err)
	}
	if pid != 0 {
		return errors.New("resident migration pending: running service requires verified idle handoff")
	}
	return nil
}
