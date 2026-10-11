package agentbus

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"golang.org/x/net/websocket"
)

// Use the relay's IPv4 preference and CA trust for both HTTP and WebSocket
// traffic. A default WebSocket dialer can pick an IPv6 source that the host's
// IP binding rejects, even while its HTTP configuration request succeeds.
func dialDaemonConnection(parent context.Context, client *relayClient) (*websocket.Conn, error) {
	ctx, cancel := context.WithTimeout(parent, 35*time.Second)
	defer cancel()
	address := strings.Replace(strings.Replace(client.baseURL, "https://", "wss://", 1), "http://", "ws://", 1) + "/host/daemon/connect"
	wc, err := websocket.NewConfig(address, client.baseURL)
	if err != nil {
		return nil, err
	}
	wc.Header.Set("X-API-Key", client.apiKey)
	transport, ok := client.http.Transport.(*http.Transport)
	if !ok || transport.DialContext == nil {
		return nil, errors.New("daemon relay transport has no dialer")
	}
	port := wc.Location.Port()
	if port == "" {
		port = "80"
		if wc.Location.Scheme == "wss" {
			port = "443"
		}
	}
	raw, err := transport.DialContext(ctx, "tcp", net.JoinHostPort(wc.Location.Hostname(), port))
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			_ = raw.Close()
		}
	}()
	done := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { _ = raw.SetDeadline(time.Now()); close(done) })
	defer stop()
	conn := raw
	if wc.Location.Scheme == "wss" {
		trust := transport.TLSClientConfig.Clone()
		trust.ServerName = wc.Location.Hostname()
		secure := tls.Client(raw, trust)
		if err := secure.HandshakeContext(ctx); err != nil {
			return nil, err
		}
		conn = secure
	}
	ws, err := websocket.NewClient(wc, conn)
	if !stop() {
		<-done
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, err
	}
	if err := raw.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	success = true
	return ws, nil
}
