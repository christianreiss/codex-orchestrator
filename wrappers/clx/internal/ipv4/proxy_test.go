package ipv4

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// dialProxyConnect opens a CONNECT tunnel to target through the proxy and
// returns the raw client side of the tunnel plus the status line the proxy
// emitted. It is the minimal reproduction of what Node's HTTPS-over-proxy
// client does: write a CONNECT request, expect "HTTP/1.1 200", then speak the
// tunneled protocol on the same socket.
func dialProxyConnect(t *testing.T, proxyURL, target string) (net.Conn, string) {
	t.Helper()
	addr := strings.TrimPrefix(proxyURL, "http://")
	c, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	if _, err := io.WriteString(c, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\n\r\n"); err != nil {
		t.Fatalf("write CONNECT: %v", err)
	}
	br := bufio.NewReader(c)
	status, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("read status line: %v", err)
	}
	// Drain the remaining response headers up to the blank line so the next
	// reader on this socket sees only tunneled bytes.
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("read headers: %v", err)
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	if br.Buffered() > 0 {
		// A correct CONNECT handshake leaves no buffered bytes before the
		// tunnel payload. Buffered leftovers mean the proxy emitted extra
		// framing (e.g. chunked headers) that corrupts the tunnel.
		t.Fatalf("unexpected buffered bytes after handshake (proxy emitted extra framing): %d", br.Buffered())
	}
	return c, strings.TrimSpace(status)
}

// TestProxyCONNECTTunnel proves the IPv4 proxy actually tunnels a CONNECT
// request end-to-end: status 200 + clean bidirectional byte copy. This is the
// real shape of every Claude Code HTTPS call routed through
// CLAUDE_FORCE_IPV4=1.
func TestProxyCONNECTTunnel(t *testing.T) {
	// Backend the tunnel connects to: a plain TCP line echo, standing in for
	// the TLS endpoint Claude Code would actually reach.
	backend, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("backend listen: %v", err)
	}
	defer backend.Close()
	go func() {
		conn, err := backend.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 4)
		if _, err := io.ReadFull(conn, buf); err != nil {
			return
		}
		_, _ = conn.Write([]byte("PONG"))
	}()

	p, err := Start(context.Background())
	if err != nil {
		t.Fatalf("start proxy: %v", err)
	}
	defer p.Stop()

	tunnel, status := dialProxyConnect(t, p.URL, backend.Addr().String())
	defer tunnel.Close()
	if !strings.HasPrefix(status, "HTTP/1.1 200") {
		t.Fatalf("CONNECT status = %q, want HTTP/1.1 200", status)
	}

	if _, err := tunnel.Write([]byte("PING")); err != nil {
		t.Fatalf("write through tunnel: %v", err)
	}
	_ = tunnel.SetReadDeadline(time.Now().Add(3 * time.Second))
	got := make([]byte, 4)
	if _, err := io.ReadFull(tunnel, got); err != nil {
		t.Fatalf("read through tunnel: %v", err)
	}
	if string(got) != "PONG" {
		t.Fatalf("tunnel payload = %q, want PONG", got)
	}
}

// TestProxyHTTPForward proves the plain-HTTP (absolute-form) path still works
// after the CONNECT routing fix, so the ServeMux→HandlerFunc change doesn't
// regress non-tunnel requests.
func TestProxyHTTPForward(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok-"+r.URL.Path)
	}))
	defer backend.Close()

	p, err := Start(context.Background())
	if err != nil {
		t.Fatalf("start proxy: %v", err)
	}
	defer p.Stop()

	pu, err := url.Parse(p.URL)
	if err != nil {
		t.Fatalf("parse proxy url: %v", err)
	}
	tr := &http.Transport{Proxy: http.ProxyURL(pu)}
	client := &http.Client{Transport: tr, Timeout: 3 * time.Second}
	resp, err := client.Get(backend.URL + "/ping")
	if err != nil {
		t.Fatalf("GET via proxy: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "ok-/ping" {
		t.Fatalf("body = %q, want ok-/ping", body)
	}
}
