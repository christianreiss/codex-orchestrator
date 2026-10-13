//go:build linux

package residency

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// Process pins a kernel process, rather than treating a reusable PID as proof
// of ownership. It exposes no signalling operation.
type Process struct {
	PID    int
	UID    int
	Start  string
	Boot   string
	SHA256 string
	fd     int
}

func processStart(pid int) (string, error) {
	body, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", err
	}
	// The comm field may contain spaces and parentheses. Fields after its final
	// closing parenthesis begin at field 3; starttime is field 22.
	end := strings.LastIndex(string(body), ")")
	if end < 0 {
		return "", errors.New("invalid process stat")
	}
	fields := strings.Fields(string(body)[end+1:])
	if len(fields) < 20 {
		return "", errors.New("incomplete process stat")
	}
	if _, err := strconv.ParseUint(fields[19], 10, 64); err != nil {
		return "", err
	}
	return fields[19], nil
}

func PinProcess(pid, uid int, expectedDigest string) (*Process, error) {
	if pid <= 0 || uid < 0 || !digestPattern.MatchString(expectedDigest) {
		return nil, errors.New("invalid expected process identity")
	}
	fd, err := unix.PidfdOpen(pid, 0)
	if err != nil {
		return nil, fmt.Errorf("pin process identity: %w", err)
	}
	p := &Process{PID: pid, UID: uid, SHA256: expectedDigest, fd: fd}
	fail := func(err error) (*Process, error) { p.Close(); return nil, err }
	info, err := os.Stat(fmt.Sprintf("/proc/%d", pid))
	if err != nil {
		return fail(err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != uid {
		return fail(errors.New("process user mismatch"))
	}
	p.Start, err = processStart(pid)
	if err != nil {
		return fail(err)
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return fail(err)
	}
	p.Boot = strings.TrimSpace(string(boot))
	digest, err := DigestFile(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return fail(err)
	}
	start, err := processStart(pid)
	if err != nil || start != p.Start || digest != expectedDigest {
		return fail(errors.New("process executable/start identity mismatch"))
	}
	if exited, err := p.Exited(); err != nil || exited {
		return fail(errors.New("process exited during identity verification"))
	}
	return p, nil
}

func (p *Process) Close() error {
	if p.fd < 0 {
		return nil
	}
	err := unix.Close(p.fd)
	p.fd = -1
	return err
}

func (p *Process) Exited() (bool, error) {
	if p.fd < 0 {
		return false, errors.New("process identity handle is closed")
	}
	fds := []unix.PollFd{{Fd: int32(p.fd), Events: unix.POLLIN}}
	_, err := unix.Poll(fds, 0)
	if err != nil {
		return false, err
	}
	if fds[0].Revents&(unix.POLLERR|unix.POLLNVAL) != 0 {
		return false, errors.New("process identity handle unavailable")
	}
	return fds[0].Revents&unix.POLLIN != 0, nil
}

func (p *Process) WaitExited(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if exited, err := p.Exited(); err != nil {
			return err
		} else if exited {
			return nil
		}
		fds := []unix.PollFd{{Fd: int32(p.fd), Events: unix.POLLIN}}
		if _, err := unix.Poll(fds, 50); err != nil && !errors.Is(err, unix.EINTR) {
			return err
		}
	}
}
