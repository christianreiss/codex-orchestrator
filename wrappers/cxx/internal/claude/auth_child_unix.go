//go:build !windows

package claude

import (
	"fmt"
	"os"
	"syscall"
)

func duplicateLeaseFile(f *os.File, name string) (*os.File, error) {
	if f == nil {
		return nil, fmt.Errorf("%s lease is closed", name)
	}
	fd, err := syscall.Dup(int(f.Fd()))
	if err != nil {
		return nil, fmt.Errorf("duplicate %s lease: %w", name, err)
	}
	return os.NewFile(uintptr(fd), name), nil
}
