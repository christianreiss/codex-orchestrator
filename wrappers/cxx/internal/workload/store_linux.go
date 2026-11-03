//go:build linux

package workload

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

type reservation struct {
	ID     string `json:"id"`
	Memory uint64 `json:"memory"`
	Owner  int    `json:"owner"`
	Start  string `json:"start"`
	Boot   string `json:"boot"`
	Group  int    `json:"group"`
}

type store struct{ dir, proc string }

func openStore() (store, error) {
	// One canonical location per UID, independent of project, engine and HOME.
	// Same-user processes are cooperative, not an adversarial security boundary.
	dir := filepath.Join("/tmp", fmt.Sprintf("cxx-workload-%d", os.Getuid()))
	if err := os.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
		return store{}, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return store{}, err
	}
	var st unix.Stat_t
	if err = unix.Lstat(dir, &st); err != nil {
		return store{}, err
	}
	if !info.IsDir() || info.Mode().Perm() != 0700 || st.Uid != uint32(os.Getuid()) {
		return store{}, fmt.Errorf("workload state directory must be a private, owned directory")
	}
	return store{dir: dir, proc: "/proc"}, nil
}

func (s store) lock(ctx context.Context) (*os.File, error) {
	fd, err := unix.Open(filepath.Join(s.dir, "lock"), unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "workload lock")
	for {
		if err = ctx.Err(); err != nil {
			f.Close()
			return nil, err
		}
		err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return f, nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) {
			f.Close()
			return nil, err
		}
		select {
		case <-ctx.Done():
			f.Close()
			return nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

func unlock(f *os.File) { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); _ = f.Close() }

func (s store) process(pid int) (group int, start string, alive bool, err error) {
	raw, err := os.ReadFile(filepath.Join(s.proc, strconv.Itoa(pid), "stat"))
	if os.IsNotExist(err) {
		return 0, "", false, nil
	}
	if err != nil {
		return 0, "", false, err
	}
	i := strings.LastIndexByte(string(raw), ')')
	if i < 0 {
		return 0, "", false, fmt.Errorf("invalid process observation")
	}
	f := strings.Fields(string(raw[i+1:]))
	if len(f) < 20 {
		return 0, "", false, fmt.Errorf("incomplete process observation")
	}
	group, err = strconv.Atoi(f[2])
	return group, f[19], f[0] != "Z" && f[0] != "X", err
}

func (s store) groupAlive(group int) (bool, error) {
	if group <= 0 {
		return false, nil
	}
	entries, err := os.ReadDir(s.proc)
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		g, _, alive, err := s.process(pid)
		if errors.Is(err, os.ErrPermission) {
			continue
		} // other users' /proc may be hidden
		if err != nil {
			return false, err
		}
		if alive && g == group {
			return true, nil
		}
	}
	return false, nil
}

func (s store) boot() (string, error) {
	b, e := os.ReadFile(filepath.Join(s.proc, "sys/kernel/random/boot_id"))
	if e != nil {
		return "", e
	}
	id := strings.TrimSpace(string(b))
	if id == "" {
		return "", fmt.Errorf("boot identity unavailable")
	}
	return id, nil
}

// Caller holds lock. Unknown/corrupt records refuse admission rather than free
// capacity. A dead wrapper does not release a still-running job process group.
func (s store) reservations() ([]reservation, uint64, error) {
	boot, err := s.boot()
	if err != nil {
		return nil, 0, err
	}
	files, err := filepath.Glob(filepath.Join(s.dir, "*.json"))
	if err != nil {
		return nil, 0, err
	}
	var records []reservation
	var total uint64
	for _, path := range files {
		r, err := s.read(filepath.Base(path))
		if err != nil {
			return nil, 0, err
		}
		if r.Boot != boot {
			if err = os.Remove(path); err != nil {
				return nil, 0, err
			}
			continue
		}
		_, start, alive, err := s.process(r.Owner)
		if err != nil {
			return nil, 0, err
		}
		owner := alive && start == r.Start
		// Published jobs remain uncertain after wrapper death: an escaped
		// descendant may still exist outside the recorded process group.
		if !owner && r.Group == 0 {
			if err = os.Remove(path); err != nil {
				return nil, 0, err
			}
			continue
		}
		if ^uint64(0)-total < r.Memory {
			return nil, 0, fmt.Errorf("reservation overflow")
		}
		total += r.Memory
		records = append(records, r)
	}
	return records, total, nil
}

func (s store) read(name string) (reservation, error) {
	var r reservation
	if filepath.Base(name) != name {
		return r, fmt.Errorf("invalid reservation name")
	}
	fd, err := unix.Open(filepath.Join(s.dir, name), unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return r, err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	if err = json.NewDecoder(io.LimitReader(f, 4096)).Decode(&r); err != nil {
		return r, err
	}
	if r.ID+".json" != name || r.Memory == 0 || r.Owner <= 0 || r.Start == "" || r.Boot == "" || r.Group < 0 {
		return r, fmt.Errorf("invalid reservation")
	}
	return r, nil
}

func (s store) write(r reservation) error {
	if _, err := uuid.Parse(r.ID); err != nil {
		return err
	}
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.dir, ".reservation-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(s.dir, r.ID+".json"))
}

func (s store) admitted(ctx context.Context, memory, reserve uint64, sample func() (memoryView, error)) (reservation, error) {
	f, err := s.lock(ctx)
	if err != nil {
		return reservation{}, err
	}
	defer unlock(f)
	if _, err = os.Lstat(filepath.Join(s.dir, "hold")); err == nil {
		return reservation{}, errHeld
	} else if !os.IsNotExist(err) {
		return reservation{}, err
	}
	_, reserved, err := s.reservations()
	if err != nil {
		return reservation{}, err
	}
	v, err := sample()
	if err != nil {
		return reservation{}, err
	}
	if usable(v, reserved, reserve) < memory {
		return reservation{}, errCapacity
	}
	_, start, _, err := s.process(os.Getpid())
	if err != nil {
		return reservation{}, err
	}
	boot, err := s.boot()
	if err != nil {
		return reservation{}, err
	}
	r := reservation{ID: uuid.NewString(), Memory: memory, Owner: os.Getpid(), Start: start, Boot: boot}
	return r, s.write(r)
}

var errHeld = errors.New("new jobs are on hold; use cxx workload resume")
var errCapacity = errors.New("insufficient unreserved memory")
