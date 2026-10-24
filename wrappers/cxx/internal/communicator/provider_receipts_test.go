package communicator

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

func TestProviderReleaseSurvivesOfflineOwnerAndReplaysAfterRestart(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	base := "https://receipt-fixture.invalid"
	id := strings.Repeat("a", 32)
	registry.Store(base, &endpoint{base: base, setupErr: errors.New("offline")})
	defer registry.Delete(base)
	queued, err := QueueProviderRelease(base, "grok", id)
	if err != nil || !queued {
		t.Fatalf("journal=%v %v", queued, err)
	}
	dir, _ := releaseDirectory(base)
	path := filepath.Join(dir, id+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var receipt providerRelease
	if json.Unmarshal(raw, &receipt) != nil || receipt.SessionID != id || receipt.Engine != "grok" {
		t.Fatalf("receipt=%s", raw)
	}
	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: base}}
	first := &server{cfg: cfg, releaseWake: make(chan struct{}, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { first.providerReleaseLoop(ctx); close(done) }()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		first.mu.Lock()
		held := first.active > 0
		first.mu.Unlock()
		if held {
			break
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-done
	if _, err := os.Stat(path); err != nil {
		t.Fatal("offline owner discarded receipt:", err)
	}
	requests := make(chan frame, 4)
	remote := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		for {
			var request frame
			if websocket.JSON.Receive(ws, &request) != nil {
				return
			}
			requests <- request
			websocket.JSON.Send(ws, frame{ID: request.ID, Status: 200})
		}
	}))
	defer remote.Close()
	ws, err := websocket.Dial("ws"+strings.TrimPrefix(remote.URL, "http"), "", remote.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	connection := &connection{ws: ws, done: make(chan struct{}), pending: map[string]chan frame{}}
	go connection.receive()
	second := &server{cfg: cfg, conn: connection, releaseWake: make(chan struct{}, 1)}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	done = make(chan struct{})
	go func() { second.providerReleaseLoop(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	select {
	case request := <-requests:
		if request.Path != "/auth/sessions/release" || request.Method != "POST" {
			t.Fatalf("request=%+v", request)
		}
		var actual providerRelease
		json.Unmarshal(request.Body, &actual)
		if actual != receipt {
			t.Fatal("release identity changed")
		}
	case <-time.After(time.Second):
		t.Fatal("receipt was not replayed")
	}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err = os.Stat(path); os.IsNotExist(err) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("acknowledged receipt retained")
	}
	select {
	case <-requests:
		t.Fatal("idle release worker repeated an acknowledged command")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestProviderReleaseRejectsUnboundedOrUnsafeIdentities(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	base := "https://receipt-validation.invalid"
	registry.Store(base, &endpoint{base: base, setupErr: errors.New("offline")})
	defer registry.Delete(base)
	if _, err := QueueProviderRelease(base, "codex", "../escape"); err == nil {
		t.Fatal("unsafe identifier accepted")
	}
	if _, err := QueueProviderRelease(base, "other", strings.Repeat("a", 32)); err == nil {
		t.Fatal("unknown engine accepted")
	}
}

func TestNativeStopReceiptSurvivesOfflineOwnerAndReplaysAfterRestart(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	base := "https://receipt-fixture.invalid"
	id := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	value := NativeStopReceipt{SessionID: id, BindingGeneration: 3, NativeInstanceID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", RequestID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", Result: "exited"}
	registry.Store(base, &endpoint{base: base, setupErr: errors.New("offline")})
	defer registry.Delete(base)
	queued, err := QueueNativeStopReceipt(base, value)
	if err != nil || !queued {
		t.Fatalf("journal=%v %v", queued, err)
	}
	dir, _ := releaseDirectory(base)
	path := filepath.Join(dir, "native-"+value.RequestID+"-exited.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var receipt providerRelease
	if json.Unmarshal(raw, &receipt) != nil || receipt.NativeStop == nil || *receipt.NativeStop != value {
		t.Fatalf("receipt=%s", raw)
	}
	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: base}}
	first := &server{cfg: cfg, releaseWake: make(chan struct{}, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { first.providerReleaseLoop(ctx); close(done) }()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		first.mu.Lock()
		held := first.active > 0
		first.mu.Unlock()
		if held {
			break
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-done
	if _, err := os.Stat(path); err != nil {
		t.Fatal("offline owner discarded receipt:", err)
	}
	requests := make(chan frame, 4)
	remote := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		for {
			var request frame
			if websocket.JSON.Receive(ws, &request) != nil {
				return
			}
			requests <- request
			websocket.JSON.Send(ws, frame{ID: request.ID, Status: 200})
		}
	}))
	defer remote.Close()
	ws, err := websocket.Dial("ws"+strings.TrimPrefix(remote.URL, "http"), "", remote.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	connection := &connection{ws: ws, done: make(chan struct{}), pending: map[string]chan frame{}}
	go connection.receive()
	second := &server{cfg: cfg, conn: connection, releaseWake: make(chan struct{}, 1)}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	done = make(chan struct{})
	go func() { second.providerReleaseLoop(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	select {
	case request := <-requests:
		if request.Path != "/host/native-control/receipt" || request.Method != "POST" {
			t.Fatalf("request=%+v", request)
		}
		var actual NativeStopReceipt
		json.Unmarshal(request.Body, &actual)
		if actual != value {
			t.Fatal("release identity changed")
		}
	case <-time.After(time.Second):
		t.Fatal("receipt was not replayed")
	}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err = os.Stat(path); os.IsNotExist(err) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("acknowledged receipt retained")
	}
	select {
	case <-requests:
		t.Fatal("idle release worker repeated an acknowledged command")
	case <-time.After(50 * time.Millisecond):
	}
}
