package residency

import (
	"context"
	"net/http"
)

// DaemonStream preserves the existing framed protocol without requiring a
// local WebSocket hop between the runtime and its execution controller.
type DaemonStream interface {
	Send(any) error
	Receive(any) error
	Close() error
}

// ExecutionTransport is supplied by the communicator, or by the legacy direct
// transport when that signed capability is disabled. It grants no admission.
type ExecutionTransport interface {
	OpenDaemon(context.Context, string) (DaemonStream, error)
	Wrap(string, http.RoundTripper) http.RoundTripper
}

type ExecutionStatus struct {
	Running  bool     `json:"running"`
	Fenced   bool     `json:"fenced"`
	Verified bool     `json:"verified"`
	Workload Workload `json:"workload"`
	Error    string   `json:"error,omitempty"`
}

type ExecutionController interface {
	Run(context.Context, ExecutionTransport) error
	Fence()
	Status() ExecutionStatus
}
