package nativeentry

import (
	"errors"
	"os"
)

// ErrForeignHome marks a home directory owned by another user. A privileged
// maintenance command run with that user's HOME (sudo env HOME=...) must not
// leave root-owned entries or shell files there: the owner can no longer read
// them, and the next launch refuses them as unmanaged.
var ErrForeignHome = errors.New("home directory belongs to another user")

// currentUID is a seam: tests cannot change their effective UID.
var currentUID = os.Geteuid
