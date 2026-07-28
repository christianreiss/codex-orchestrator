// Package ipv4 implements a tiny HTTP/CONNECT forward proxy that forces all
// outbound traffic to IPv4. The legacy bash wrapper used an embedded Python
// proxy for this; Go has a stdlib net.Dialer that we constrain to "tcp4".
//
// The proxy listens on 127.0.0.1:0 and serves HTTP/1.1 absolute-URL requests
// and CONNECT tunnels. It's intentionally minimal: no caching, no auth, no
// proxy-chaining. cdx exports HTTP(S)_PROXY=$URL and Codex (Node) follows.
package ipv4

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// idleTunnelTimeout bounds how long a CONNECT tunnel may sit with no data
// flowing in either direction. It's refreshed on every successful read, so
// active-but-slow tunnels are unaffected; only a peer that goes silent
// without closing the socket gets reaped.
const idleTunnelTimeout = 10 * time.Minute

// Proxy is a started IPv4-forcing proxy.
type Proxy struct {
	URL    string
	server *http.Server
	wg     sync.WaitGroup
}

// Start spins up the proxy on a kernel-assigned 127.0.0.1 port.
func Start(ctx context.Context) (*Proxy, error) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	addr := ln.Addr().(*net.TCPAddr)

	dialer := &net.Dialer{
		Timeout: 30 * time.Second,
		Resolver: &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				d := net.Dialer{}
				net4 := "udp4"
				if strings.HasPrefix(network, "tcp") {
					net4 = "tcp4"
				}
				return d.DialContext(ctx, net4, address)
			},
		},
	}
	dial4 := func(ctx context.Context, network, address string) (net.Conn, error) {
		return dialer.DialContext(ctx, "tcp4", address)
	}

	transport := &http.Transport{
		DialContext:         dial4,
		TLSHandshakeTimeout: 10 * time.Second,
	}

	// Route directly through an http.HandlerFunc rather than an http.ServeMux:
	// ServeMux issues a 301 redirect for CONNECT requests (it tries the
	// /tree → /tree/ slash redirect before dispatching), which kills every
	// HTTPS tunnel — and HTTPS is essentially all of Claude Code's API traffic.
	// A bare handler sees CONNECT verbatim.
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			handleConnect(w, r, dial4)
			return
		}
		handleHTTP(w, r, transport)
	})

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       idleTunnelTimeout,
	}
	p := &Proxy{URL: fmt.Sprintf("http://127.0.0.1:%d", addr.Port), server: srv}
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		_ = srv.Serve(ln)
	}()
	return p, nil
}

// Stop closes the proxy and waits for in-flight connections.
func (p *Proxy) Stop() {
	if p == nil || p.server == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = p.server.Shutdown(ctx)
	p.wg.Wait()
}

func handleConnect(w http.ResponseWriter, r *http.Request, dial func(ctx context.Context, network, addr string) (net.Conn, error)) {
	host := r.URL.Host
	if !strings.Contains(host, ":") {
		host += ":443"
	}
	dst, err := dial(r.Context(), "tcp4", host)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer dst.Close()

	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking not supported", http.StatusInternalServerError)
		return
	}
	// Do NOT call w.WriteHeader before hijacking: net/http would flush its own
	// status line + Date + chunked-Transfer-Encoding headers, and the manual
	// "200 OK" below plus the tunneled bytes would then arrive as chunked body,
	// corrupting the handshake. Hijack first, then write the single CONNECT-OK
	// status line ourselves.
	src, _, err := hj.Hijack()
	if err != nil {
		return
	}
	defer src.Close()
	_, _ = src.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

	sc := &idleConn{Conn: src, timeout: idleTunnelTimeout}
	dc := &idleConn{Conn: dst, timeout: idleTunnelTimeout}

	go io.Copy(dc, sc) //nolint:errcheck
	io.Copy(sc, dc)    //nolint:errcheck
}

// idleConn wraps a net.Conn and resets its read/write deadlines on every
// successful I/O call, so a genuinely stalled peer eventually errors out of
// io.Copy instead of pinning the goroutine/fd pair open for the process
// lifetime, while active-but-slow tunnels are left alone.
type idleConn struct {
	net.Conn
	timeout time.Duration
}

func (c *idleConn) Read(b []byte) (int, error) {
	_ = c.Conn.SetReadDeadline(time.Now().Add(c.timeout))
	return c.Conn.Read(b)
}

func (c *idleConn) Write(b []byte) (int, error) {
	_ = c.Conn.SetWriteDeadline(time.Now().Add(c.timeout))
	return c.Conn.Write(b)
}

func handleHTTP(w http.ResponseWriter, r *http.Request, transport *http.Transport) {
	// Forward absolute-form HTTP request.
	r.RequestURI = ""
	for _, h := range []string{"Proxy-Connection", "Connection"} {
		r.Header.Del(h)
	}
	resp, err := transport.RoundTrip(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
