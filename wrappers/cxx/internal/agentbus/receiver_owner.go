package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

// Native subagents inherit the launch's MCP configuration. Their MCP processes
// must use the same receiver and receipt tracker, rather than trying to register
// another generation or answering a Portal delivery with an empty local tracker.
// The private launch broker directory scopes both election and tool forwarding.
type receiverOwner struct {
	mu      sync.Mutex
	owned   bool
	path    string
	client  *sessionClient
	tracker *channelTracker
	// Test fixtures replace native reception while exercising real Unix IPC.
	runReceiver func(context.Context, io.Writer)
}

func newReceiverOwner(client *sessionClient, tracker *channelTracker) *receiverOwner {
	broker := os.Getenv(envSocket)
	if broker == "" || client.id != os.Getenv(envSessionID) { // In-process fixtures do not own the inherited launch broker.
		return nil
	}
	return &receiverOwner{path: filepath.Join(filepath.Dir(broker), ownerSocketName), client: client, tracker: tracker}
}

func (o *receiverOwner) isOwner() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.owned
}

func (o *receiverOwner) run(ctx context.Context, stderr io.Writer) {
	for ctx.Err() == nil {
		lease, err := ipc.TryAcquireExclusivePath(o.path + ".lock")
		if err == nil {
			err = o.serve(ctx, stderr)
			_ = lease.Release()
		}
		if err != nil && !errors.Is(err, ipc.ErrHeld) && ctx.Err() == nil {
			fmt.Fprintln(stderr, "cxx receiver owner: unavailable:", sanitizedError(err))
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (o *receiverOwner) serve(ctx context.Context, stderr io.Writer) error {
	// Only the lease holder removes a stale endpoint. Its parent is the existing
	// mode-0700 broker directory; the socket itself grants no access to other users.
	if err := os.Remove(o.path); err != nil && !os.IsNotExist(err) {
		return err
	}
	listener, err := net.Listen("unix", o.path)
	if err != nil {
		return err
	}
	defer listener.Close()
	defer os.Remove(o.path)
	if err := os.Chmod(o.path, 0o600); err != nil {
		return err
	}
	ownerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	o.mu.Lock()
	o.owned = true
	o.mu.Unlock()
	defer func() { o.mu.Lock(); o.owned = false; o.mu.Unlock() }()
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && (r.URL.Path == ownerHeldPath || r.URL.Path == ownerReleasePath) {
			o.serveTurn(w, r, ownerCtx)
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/tools" {
			http.Error(w, "unknown receiver operation", http.StatusNotFound)
			return
		}
		var input struct {
			SessionID string     `json:"session_id"`
			Request   mcpRequest `json:"request"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&input); err != nil || input.SessionID != o.client.id || input.Request.Method != "tools/call" {
			http.Error(w, "invalid receiver request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(handleMCPRequest(ownerCtx, o.client, input.Request, false, o.tracker))
	})}
	// Keep the elected owner alive until its receiver has actually stopped. A
	// successor cannot race a deferred stop against its new registration.
	done := make(chan struct{})
	go func() {
		defer close(done)
		if o.runReceiver != nil {
			o.runReceiver(ownerCtx, stderr)
		} else {
			o.tracker.receiver.run(ownerCtx, stderr)
		}
	}()
	go func() { <-ownerCtx.Done(); _ = server.Close() }()
	err = server.Serve(listener)
	cancel()
	<-done
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (o *receiverOwner) forward(ctx context.Context, request mcpRequest) map[string]any {
	// An initialized MCP client may call tools before the owner's goroutine has
	// opened its socket. Wait only for connection establishment, before exposing
	// any mutation; never resend an HTTP request after it has been submitted.
	deadline := time.Now().Add(receiverReadyWait)
	for {
		conn, err := (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "unix", o.path)
		if err == nil {
			_ = conn.Close()
			break
		}
		if ctx.Err() != nil || !time.Now().Before(deadline) {
			break
		}
		select {
		case <-ctx.Done():
		case <-time.After(25 * time.Millisecond):
		}
	}
	client := sessionClientAt(o.path, o.client.id, 35*time.Second)
	body := map[string]any{"session_id": o.client.id, "request": request}
	var out map[string]any
	// Never retry a tool mutation after an uncertain response. Existing send and
	// result idempotency contracts remain the caller's recovery mechanism.
	err := doJSON(ctx, client.http, "http://receiver.local", http.MethodPost, "/tools", body, nil, &out)
	client.http.CloseIdleConnections()
	if err != nil {
		return mcpSuccess(request.ID, map[string]any{"isError": true, "content": []map[string]any{{"type": "text", "text": "Shared receiver tool response unavailable; effects may have occurred. Retry only the same idempotent tool arguments or inspect the retained message receipt: " + sanitizedError(err)}}})
	}
	return out
}
