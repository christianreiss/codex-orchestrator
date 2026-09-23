package ipv4

import (
	"context"
	"net"
	"strings"
	"time"
)

// PreferDialContext returns a DialContext suitable for an http.Transport that
// tries an IPv4 connection first and falls back to the network's default
// (dual-stack) dial when no IPv4 route exists for the address — e.g. an
// IPv6-only host, or a AAAA-only DNS record.
//
// This exists because a host's orchestrator API key is bound to a single
// source IP (see host-auth.ts enforceIpBinding) and non-roaming hosts are
// rejected the moment their egress address changes. On a dual-stack host
// with IPv6 privacy/temporary addresses, Go's default happy-eyeballs dial
// picks a *different* IPv6 source address on every connection, which a
// secure, non-roaming host can never satisfy. Almost every host was bound
// over IPv4 at registration, so pinning the wrapper's own orchestrator
// traffic to IPv4 by default restores a stable source address without
// requiring an admin to flip roaming on.
func PreferDialContext() func(ctx context.Context, network, address string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 30 * time.Second}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		if strings.HasPrefix(network, "tcp") {
			if conn, err := d.DialContext(ctx, "tcp4", address); err == nil {
				return conn, nil
			}
		}
		return d.DialContext(ctx, network, address)
	}
}
