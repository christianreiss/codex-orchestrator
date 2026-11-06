package agentbus

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

func runDaemonPeersControlled(ctx context.Context, version string, mu *sync.Mutex, active map[string]context.CancelFunc, stderr io.Writer, controller *ResidentController) {
	instanceID := newUUID()
	logs := newPeerRelayLog(stderr)
	for ctx.Err() == nil {
		configs, client, settings, err := daemonConfigWithController(ctx, controller)
		if err != nil || !settings.Enabled || daemonLocalExpired() {
			switch {
			case err != nil:
				logs.printf("config", "daemon peer relay not registered: configuration unavailable: %v", err)
			case !settings.Enabled:
				logs.printf("config", "daemon peer relay not registered: host daemon is disabled")
			default:
				logs.printf("config", "daemon peer relay not registered: host daemon deadline expired")
			}
			if !waitContext(ctx, 5*time.Second) {
				return
			}
			continue
		}
		client.daemon = true
		if controller != nil {
			client.claimPermit = controller.permit
		}
		registration, err := client.register(ctx, settings.Username+":daemon", instanceID, version)
		if err != nil {
			logs.printf("register", "daemon peer relay registration as %s:daemon failed: %v", settings.Username, err)
			if !waitContext(ctx, 5*time.Second) {
				return
			}
			continue
		}
		logs.printf("registered", "daemon peer relay registered as %s:daemon (relay %s)", settings.Username, registration.RelayID)
		client.id, client.token = registration.RelayID, registration.RelayToken
		client.beforeDelivery = func(parent context.Context, delivery *relayDelivery) (context.Context, func()) {
			runCtx, stop := context.WithCancel(parent)
			dir, journalErr := daemonStateDir()
			path := filepath.Join(dir, "receipts", delivery.MessageID+".json")
			receipt := map[string]any{"session_id": stringArg(delivery.Target, "daemon_session_id"), "message_id": delivery.MessageID, "ready": false}
			body, _ := json.Marshal(receipt)
			if daemonLocalExpired() || journalErr != nil || writeProtectedFile(path, body) != nil {
				stop()
			}
			id := stringArg(delivery.Target, "daemon_session_id")
			mu.Lock()
			active[id] = stop
			mu.Unlock()
			return runCtx, func() {
				stop()
				mu.Lock()
				delete(active, id)
				mu.Unlock()
				receipt["ready"] = true
				body, _ := json.Marshal(receipt)
				if writeProtectedFile(path, body) == nil {
					replayDaemonPeerReceipts(ctx, client)
				}

			}
		}
		poolCtx, cancel := context.WithCancel(ctx)
		replayDone := make(chan struct{})
		go func() {
			defer close(replayDone)
			for {
				replayDaemonPeerReceipts(poolCtx, client)
				if !waitContext(poolCtx, 15*time.Second) {
					return
				}
			}
		}()

		if err := client.pollParallel(poolCtx, configs, stderr, settings.MaxParallel); err != nil && ctx.Err() == nil {
			logs.printf("ended", "daemon peer relay connection ended; registering again: %v", err)
		}
		cancel()
		<-replayDone
		if !waitContext(ctx, 5*time.Second) {
			return
		}
	}
}

// The peer loop retries every 5 s. A silent loop once hid a daemon that never
// registered its <user>:daemon relay for days (feedback f4b31207), so each
// condition is logged: an unchanged line at most every peerRelayLogEvery, a
// changed line in the same category at most every peerRelayLogChanged.
const (
	peerRelayLogEvery   = 10 * time.Minute
	peerRelayLogChanged = time.Minute
)

type peerRelayLogEntry struct {
	line string
	at   time.Time
}

// peerRelayLog rate-limits peer-relay diagnostics per category. The loop
// goroutine is its only caller.
type peerRelayLog struct {
	out  io.Writer
	now  func() time.Time
	seen map[string]peerRelayLogEntry
}

func newPeerRelayLog(out io.Writer) *peerRelayLog {
	return &peerRelayLog{out: out, now: time.Now, seen: map[string]peerRelayLogEntry{}}
}

func (l *peerRelayLog) printf(category, format string, args ...any) {
	if l == nil || l.out == nil {
		return
	}
	line, now := fmt.Sprintf(format, args...), l.now()
	if last, ok := l.seen[category]; ok {
		elapsed := now.Sub(last.at)
		if elapsed < peerRelayLogChanged || (last.line == line && elapsed < peerRelayLogEvery) {
			return
		}
	}
	l.seen[category] = peerRelayLogEntry{line: line, at: now}
	fmt.Fprintln(l.out, line)
}

func replayDaemonPeerReceipts(ctx context.Context, client *relayClient) {
	dir, err := daemonStateDir()
	if err != nil {
		return
	}
	files, _ := filepath.Glob(filepath.Join(dir, "receipts", "*.json"))
	for _, path := range files {
		body, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var receipt map[string]any
		if json.Unmarshal(body, &receipt) != nil {
			continue
		}
		if ready, _ := receipt["ready"].(bool); !ready {
			continue
		}
		delete(receipt, "ready")
		if doJSON(ctx, client.http, client.baseURL, http.MethodPost, "/host/daemon/peer-finished", receipt, map[string]string{"X-API-Key": client.apiKey}, nil) == nil {
			_ = os.Remove(path)
		}
	}
}

// A new system-service process owns an exclusive journal lock; systemd has
// stopped the old control group. Receipts survive without replaying native work.
func recoverDaemonPeerReceipts(dir string) {
	files, _ := filepath.Glob(filepath.Join(dir, "receipts", "*.json"))
	for _, path := range files {
		body, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var receipt map[string]any
		if json.Unmarshal(body, &receipt) != nil {
			continue
		}
		receipt["ready"] = true
		body, _ = json.Marshal(receipt)
		_ = writeProtectedFile(path, body)
	}
}
