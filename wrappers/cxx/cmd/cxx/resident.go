package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentbus"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
)

func runResidentCommunicator(parent context.Context, path string) error {
	ctx, cancel := signal.NotifyContext(parent, syscall.SIGTERM, os.Interrupt)
	defer cancel()
	return communicator.ServeResident(ctx, path, Version, communicator.ResidentOptions{
		Controller: func() residency.ExecutionController {
			return agentbus.NewResidentController(Version, os.Stdout, os.Stderr)
		},
		DirectDaemon: agentbus.OpenDirectResidentDaemon,
	})
}
