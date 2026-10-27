package agentbus

import (
	"context"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

func TestRelayHTTPClientRejectsForeignRedirect(t *testing.T) {
	reached := make(chan struct{}, 1)
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached <- struct{}{} }))
	defer sink.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, sink.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	client, err := newRelayClient(&config.Config{Orchestrator: config.Orchestrator{BaseURL: origin.URL, APIKey: "private"}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.http.CloseIdleConnections()
	if _, err := client.register(context.Background(), "user", "instance", "dev"); err == nil {
		t.Fatal("foreign redirect accepted")
	}
	select {
	case <-reached:
		t.Fatal("foreign server received request")
	default:
	}
}

func TestDaemonConnectionUsesRelayDialerAndTrust(t *testing.T) {
	for _, secure := range []bool{false, true} {
		t.Run(map[bool]string{false: "http", true: "https"}[secure], func(t *testing.T) {
			header := make(chan http.Header, 1)
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/host/daemon/connect" {
					t.Errorf("path = %s", r.URL.Path)
				}
				header <- r.Header.Clone()
				websocket.Handler(func(ws *websocket.Conn) {
					defer ws.Close()
					var value string
					if websocket.Message.Receive(ws, &value) == nil {
						_ = websocket.Message.Send(ws, value)
					}
				}).ServeHTTP(w, r)
			})
			server := httptest.NewUnstartedServer(handler)
			if secure {
				server.StartTLS()
			} else {
				server.Start()
			}
			defer server.Close()
			base := strings.Replace(server.URL, "127.0.0.1", "localhost", 1)
			if secure {
				base = strings.Replace(server.URL, "127.0.0.1", "example.com", 1)
			}
			client, err := newRelayClient(&config.Config{Orchestrator: config.Orchestrator{BaseURL: base, APIKey: "test-key"}})
			if err != nil {
				t.Fatal(err)
			}
			transport := client.http.Transport.(*http.Transport)
			if secure {
				pool := x509.NewCertPool()
				pool.AddCert(server.Certificate())
				transport.TLSClientConfig.RootCAs = pool
			}
			calls := 0
			transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
				calls++
				if network != "tcp" || address != strings.TrimPrefix(strings.TrimPrefix(base, "https://"), "http://") {
					t.Errorf("dial %s %s", network, address)
				}
				return (&net.Dialer{}).DialContext(ctx, "tcp4", server.Listener.Addr().String())
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			ws, err := dialDaemonConnection(ctx, client)
			if err != nil {
				t.Fatal(err)
			}
			defer ws.Close()
			cancel() // handshake cancellation must no longer affect the live socket
			if calls != 1 {
				t.Fatalf("relay dialer calls = %d", calls)
			}
			h := <-header
			if h.Get("X-API-Key") != "test-key" || h.Get("Origin") != base {
				t.Fatal("missing host credentials or origin", h)
			}
			_ = ws.SetDeadline(time.Now().Add(time.Second))
			if err := websocket.Message.Send(ws, "connected"); err != nil {
				t.Fatal(err)
			}
			var value string
			if err := websocket.Message.Receive(ws, &value); err != nil || value != "connected" {
				t.Fatal(value, err)
			}
		})
	}
}

func TestDaemonConnectionRejectsUntrustedTLS(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("untrusted TLS reached handler") }))
	defer server.Close()
	client, err := newRelayClient(&config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"}})
	if err != nil {
		t.Fatal(err)
	}
	if ws, err := dialDaemonConnection(context.Background(), client); err == nil {
		ws.Close()
		t.Fatal("accepted an untrusted server")
	}
}

func TestDaemonConnectionCancelsStalledUpgrade(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	defer server.Close()
	defer close(release)
	client, err := newRelayClient(&config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if ws, err := dialDaemonConnection(ctx, client); !errors.Is(err, context.DeadlineExceeded) {
		if ws != nil {
			ws.Close()
		}
		t.Fatalf("stalled upgrade = %v", err)
	}
}
