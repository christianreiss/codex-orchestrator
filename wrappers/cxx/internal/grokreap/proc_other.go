//go:build !linux

package grokreap

// Live is unavailable without /proc: macOS and the BSDs keep their leftovers
// until a Linux-equivalent identity source (pidfd, start time) is wired in.
func Live(bool) (Proc, Locks, Signaler, error) {
	return nil, nil, nil, ErrUnsupported
}
