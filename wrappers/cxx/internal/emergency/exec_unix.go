//go:build !windows

package emergency

import "syscall"

// execNative replaces this process, so no wrapper supervision, lease or signal
// forwarding remains between the terminal and the native CLI. It only returns
// when exec(2) itself failed.
func execNative(path string, argv, env []string) (int, error) {
	return 1, syscall.Exec(path, argv, env)
}
