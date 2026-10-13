//go:build !linux

package agentbus

import (
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"io"
	"os/user"
)

func migrateResidentService(map[string]*config.Config, *relayClient, daemonSettings, *user.User, string, string, io.Writer, io.Writer) error {
	return errors.New("resident migration requires Linux")
}

func rollbackResidentService(io.Writer, io.Writer) error {
	return errors.New("resident rollback requires Linux")
}
