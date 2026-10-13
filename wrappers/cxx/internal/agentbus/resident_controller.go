package agentbus

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
	"golang.org/x/net/websocket"
)

// ResidentController owns only daemon execution. Residence never grants an
// account/session lease; the existing signed config and server admission still
// govern every operation. Nil controller hooks retain the legacy daemon path.
type ResidentController struct {
	mu                       sync.Mutex
	version                  string
	stdout, stderr           io.Writer
	transport                residency.ExecutionTransport
	running, fenced, started bool
	permits                  int
	permitRevision           uint64
	snapshot                 func() (residency.Workload, error)
	snapshotRevision         uint64
	lastError                error
}

var _ residency.ExecutionController = (*ResidentController)(nil)

func NewResidentController(version string, stdout, stderr io.Writer) *ResidentController {
	return &ResidentController{version: version, stdout: stdout, stderr: stderr}
}

func (c *ResidentController) Run(ctx context.Context, transport residency.ExecutionTransport) error {
	if transport == nil {
		return errors.New("resident execution transport is missing")
	}
	c.mu.Lock()
	if c.running {
		c.mu.Unlock()
		return errors.New("resident execution controller is already running")
	}
	c.running, c.started, c.transport, c.lastError = true, true, transport, nil
	c.snapshot = nil
	c.snapshotRevision++
	c.mu.Unlock()
	err := runHostExecution(ctx, c.version, c.stdout, c.stderr, c)
	c.mu.Lock()
	c.running, c.lastError = false, err
	c.mu.Unlock()
	return err
}

// Fence stops new permits without cancelling existing permits or children.
func (c *ResidentController) Fence() { c.mu.Lock(); c.fenced = true; c.mu.Unlock() }

func (c *ResidentController) ResumeAdmission() { c.mu.Lock(); c.fenced = false; c.mu.Unlock() }

func (c *ResidentController) permit() (func(), bool) {
	if c == nil {
		return func() {}, true
	}
	c.mu.Lock()
	if c.fenced {
		c.mu.Unlock()
		return nil, false
	}
	c.permits++
	c.permitRevision++
	c.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { c.mu.Lock(); c.permits--; c.permitRevision++; c.mu.Unlock() }) }, true
}

func (c *ResidentController) bindSnapshot(snapshot func() (residency.Workload, error)) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.snapshot = snapshot
	c.snapshotRevision++
	c.mu.Unlock()
}

func (c *ResidentController) Status() residency.ExecutionStatus {
	c.mu.Lock()
	snapshot, revision := c.snapshot, c.snapshotRevision
	permits, permitRevision := c.permits, c.permitRevision
	c.mu.Unlock()
	// Receipt directory I/O can be slow. It must never hold the admission
	// mutex or delay fencing/permit release. A rebind invalidates this sample.
	var work residency.Workload
	var err error
	if snapshot != nil {
		work, err = snapshot()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	status := residency.ExecutionStatus{Running: c.running, Fenced: c.fenced,
		Verified: c.started && snapshot != nil && revision == c.snapshotRevision && permitRevision == c.permitRevision && c.lastError == nil && err == nil,
		Workload: work}
	if err != nil {
		status.Error = err.Error()
	}
	// A permit may finish and persist a receipt after the directory was read.
	// Keep that sample conservative; the next stable snapshot can prove idle.
	status.Workload.PeerClaims += max(permits, c.permits)
	if c.lastError != nil {
		status.Error = c.lastError.Error()
	}
	return status
}

func (c *ResidentController) wrapClient(client *relayClient) {
	if c == nil {
		return
	}
	c.mu.Lock()
	transport := c.transport
	c.mu.Unlock()
	if transport != nil {
		direct := client.http.Transport
		if original, ok := communicator.Direct(direct); ok {
			direct = original
		}
		client.http.Transport = transport.Wrap(client.baseURL, direct)
	}
}

func (c *ResidentController) openDaemon(ctx context.Context, client *relayClient) (residency.DaemonStream, error) {
	if c != nil {
		c.mu.Lock()
		transport := c.transport
		c.mu.Unlock()
		if transport == nil {
			return nil, errors.New("resident execution transport is unavailable")
		}
		return transport.OpenDaemon(ctx, client.baseURL)
	}
	ws, err := dialDaemonConnection(ctx, client)
	if err != nil {
		return nil, err
	}
	ws.MaxPayloadBytes = 2 * 1024 * 1024
	return websocketDaemonStream{ws}, nil
}

type websocketDaemonStream struct{ *websocket.Conn }

func (s websocketDaemonStream) Send(value any) error    { return websocket.JSON.Send(s.Conn, value) }
func (s websocketDaemonStream) Receive(value any) error { return websocket.JSON.Receive(s.Conn, value) }

// verifiedPendingReceipts refuses unreadable state rather than reporting zero
// after a failed Glob. Every journal, including corrupt/ambiguous ones, blocks
// planned replacement until handled through the existing recovery contract.
func verifiedPendingReceipts(dir string) (int, error) {
	count := 0
	for _, root := range []string{dir, filepath.Join(dir, "receipts")} {
		entries, err := os.ReadDir(root)
		if errors.Is(err, os.ErrNotExist) && root != dir {
			continue
		}
		if err != nil {
			return 0, err
		}
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".json") && entry.Name() != "deadline.json" {
				count++
			}
		}
	}
	return count, nil
}
