//go:build !linux

package workload

import (
	"fmt"
	"io"
)

func platformCommand(_ []string, _ io.Reader, _ io.Writer, stderr io.Writer) int {
	fmt.Fprintln(stderr, "cxx workload: memory admission is supported on Linux only")
	return 2
}
