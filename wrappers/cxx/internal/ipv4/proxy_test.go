package ipv4

import (
	"bufio"
	"context"
	"fmt"
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
// real shape of every Codex HTTPS call routed through CODEX_FORCE_IPV4=1.
func TestProxyCONNECTTunnel(t *testing.T) {
	// Backend the tunnel connects to: a plain TCP line echo, standing in for
	// the TLS endpoint Codex would actually reach.
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

func TestProxyConnectPreservesReadAheadPayload(t *testing.T) {
	backend, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	go func() {
		conn, err := backend.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(2 * time.Second))
		payload := make([]byte, 4)
		if _, err := io.ReadFull(conn, payload); err == nil {
			conn.Write(payload)
		}
	}()
	p, err := Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer p.Stop()
	u, _ := url.Parse(p.URL)
	conn, err := net.Dial("tcp4", u.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	// One write forces net/http's request reader to buffer tunnel bytes too.
	if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\nPING", backend.Addr(), backend.Addr()); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	got := make([]byte, 4)
	if _, err := io.ReadFull(reader, got); err != nil || string(got) != "PING" {
		t.Fatalf("read-ahead lost: %q, %v", got, err)
	}
}

func TestProxyStripsHopHeadersInBothDirections(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, name := range []string{"X-Request-Hop", "Proxy-Authorization", "Proxy-Connection"} {
			if r.Header.Get(name) != "" {
				t.Errorf("forwarded %s", name)
			}
		}
		w.Header().Set("Connection", "X-Response-Hop")
		w.Header().Set("X-Response-Hop", "private")
		w.Write([]byte("ok"))
	}))
	defer backend.Close()
	p, err := Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer p.Stop()
	u, _ := url.Parse(p.URL)
	transport := &http.Transport{Proxy: http.ProxyURL(u)}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	req, _ := http.NewRequest("GET", backend.URL, nil)
	req.Header.Set("Connection", "X-Request-Hop")
	req.Header.Set("X-Request-Hop", "private")
	req.Header.Set("Proxy-Authorization", "private")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("X-Response-Hop") != "" {
		t.Error("forwarded response connection header")
	}
}

func TestProxyCancellationClosesHijackedTunnels(t *testing.T) {
	backend, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		conn, err := backend.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = io.Copy(io.Discard, conn)
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p, err := Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Stop()
	conn, _ := dialProxyConnect(t, p.URL, backend.Addr().String())
	defer conn.Close()
	cancel()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("cancellation left a hijacked tunnel open")
	}
	p.Stop() // safe after context cancellation and safe to repeat
}
