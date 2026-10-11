//go:build darwin

package atomicdir

import "golang.org/x/sys/unix"

func exchange(stage, target string) error  { return unix.RenamexNp(stage, target, unix.RENAME_SWAP) }
func renameNew(stage, target string) error { return unix.RenamexNp(stage, target, unix.RENAME_EXCL) }
