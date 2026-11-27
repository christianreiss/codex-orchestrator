//go:build !windows

package nativeentry

import (
	"fmt"
	"os"
	"syscall"
)

func checkHomeOwner(home string) error {
	info, err := os.Stat(home)
	if err != nil {
		return err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	if uid := currentUID(); int(st.Uid) != uid {
		return fmt.Errorf("%w: %s is owned by uid %d, running as uid %d; run as that user instead", ErrForeignHome, home, st.Uid, uid)
	}
	return nil
}
