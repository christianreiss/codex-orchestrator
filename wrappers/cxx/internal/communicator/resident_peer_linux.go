//go:build linux

package communicator

import (
	"errors"
	"net"
	"os"
	"syscall"
)

func verifyResidentPeer(raw net.Conn, pid int) error {
	conn, ok := raw.(*net.UnixConn)
	if !ok {
		return errors.New("runtime peer is not a Unix connection")
	}
	control, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	var credentials *syscall.Ucred
	var lookupErr error
	if err := control.Control(func(fd uintptr) {
		credentials, lookupErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return err
	}
	if lookupErr != nil {
		return lookupErr
	}
	if credentials == nil || int(credentials.Uid) != os.Getuid() || int(credentials.Pid) != pid {
		return errors.New("runtime socket peer identity mismatch")
	}
	return nil
}
