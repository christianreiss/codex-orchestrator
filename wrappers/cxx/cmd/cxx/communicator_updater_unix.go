//go:build !windows

package main

import (
	"path/filepath"

	"golang.org/x/sys/unix"
)

func updaterTargetWritable(path string) bool {
	return unix.Access(filepath.Dir(path), unix.W_OK) == nil
}
