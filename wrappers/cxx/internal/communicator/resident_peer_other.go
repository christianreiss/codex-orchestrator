//go:build !linux

package communicator

import "net"

// Non-Linux on-demand clients retain the existing private-socket trust boundary.
// Resident systemd service management remains Linux-only.
func verifyResidentPeer(raw net.Conn, pid int) error { return nil }
