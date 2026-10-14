package nativeentry

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// ErrForeignHome marks a home directory owned by another user. A privileged
// maintenance command run with that user's HOME (sudo env HOME=...) must not
// leave root-owned entries or shell files there: the owner can no longer read
// them, and the next launch refuses them as unmanaged.
var ErrForeignHome = errors.New("home directory belongs to another user")

// currentUID is a seam: tests cannot change their effective UID.
var currentUID = os.Geteuid

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
