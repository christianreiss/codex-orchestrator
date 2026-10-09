package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

func runDaemonPeers(ctx context.Context, version string, mu *sync.Mutex, active map[string]context.CancelFunc, stderr io.Writer) {
	for ctx.Err() == nil {
		configs, client, settings, err := daemonConfig(ctx)
		if err != nil || !settings.Enabled {
			if !waitContext(ctx, 5*time.Second) {
				return
			}
			continue
		}
		client.daemon = true
		registration, err := client.register(ctx, settings.Username+":daemon", newUUID(), version)
		if err != nil {
			if !waitContext(ctx, 5*time.Second) {
				return
			}
			continue
		}
		client.id, client.token = registration.RelayID, registration.RelayToken
		client.beforeDelivery = func(parent context.Context, delivery *relayDelivery) (context.Context, func()) {
			runCtx, stop := context.WithCancel(parent)
			dir, journalErr := daemonStateDir()
			path := filepath.Join(dir, "receipts", delivery.MessageID+".json")
			receipt := map[string]any{"session_id": stringArg(delivery.Target, "daemon_session_id"), "message_id": delivery.MessageID, "ready": false}
			body, _ := json.Marshal(receipt)
			if journalErr != nil || writeProtectedFile(path, body) != nil {
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

		var wg sync.WaitGroup
		for i := 0; i < settings.MaxParallel; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); defer cancel(); _ = client.poll(poolCtx, configs, stderr) }()
		}
		wg.Wait()
		cancel()
		<-replayDone
		if !waitContext(ctx, 5*time.Second) {
			return
		}
	}
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
