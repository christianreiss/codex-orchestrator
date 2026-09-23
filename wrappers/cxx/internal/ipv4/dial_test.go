package ipv4

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestPreferDialContext_PrefersIPv4(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp4: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()

	dial := PreferDialContext()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := dial(ctx, "tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial via IPv4 listener: %v", err)
	}
	defer conn.Close()
	if conn.RemoteAddr().(*net.TCPAddr).IP.To4() == nil {
		t.Fatalf("expected an IPv4 remote address, got %v", conn.RemoteAddr())
	}
}

func TestPreferDialContext_FallsBackToIPv6Only(t *testing.T) {
	ln, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Skipf("IPv6 loopback unavailable in this environment: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()

	dial := PreferDialContext()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := dial(ctx, "tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("expected fallback dial to the IPv6-only listener to succeed: %v", err)
	}
	defer conn.Close()
}

func TestPreferDialContext_NonTCPUnaffected(t *testing.T) {
	ln, err := net.Listen("unix", t.TempDir()+"/dial.sock")
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()

	dial := PreferDialContext()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := dial(ctx, "unix", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial unix socket: %v", err)
	}
	conn.Close()
}
