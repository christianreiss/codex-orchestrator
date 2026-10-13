package communicator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
)

type residentOwnerRecord struct {
	Base      string `json:"base"`
	Namespace string `json:"namespace"`
	Socket    string `json:"socket"`
	Instance  string `json:"instance"`
	PID       int    `json:"pid"`
}

func residentCoordination(base string) (string, string, error) {
	namespace, err := residency.Namespace(os.Getuid(), os.Getenv("XDG_RUNTIME_DIR"))
	if err != nil {
		return "", "", err
	}
	return filepath.Join("/tmp", fmt.Sprintf("cxx-%d", os.Getuid()), "owner-"+residency.Key(os.Getuid(), base, namespace)), namespace, nil
}

func privateOwnedDirectory(path string) error { return privateOwnedDirectoryFor(path, os.Getuid()) }

func privateOwnedDirectoryFor(path string, uid int) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != uid || !info.IsDir() || info.Mode().Perm() != 0700 {
		return errors.New("unsafe runtime namespace directory")
	}
	return nil
}

func readResidentOwner(base string) (residentOwnerRecord, error) {
	dir, namespace, err := residentCoordination(base)
	if err != nil {
		return residentOwnerRecord{}, err
	}
	return readResidentOwnerAt(base, dir, namespace, os.Getuid())
}

func readResidentOwnerAt(base, dir, namespace string, uid int) (residentOwnerRecord, error) {
	var record residentOwnerRecord
	if err := privateOwnedDirectoryFor(filepath.Dir(dir), uid); err != nil {
		return record, err
	}
	if err := privateOwnedDirectoryFor(dir, uid); err != nil {
		return record, err
	}
	path := filepath.Join(dir, "owner.json")
	info, err := os.Lstat(path)
	if err != nil {
		return record, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != uid || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return record, errors.New("unsafe runtime ownership record")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return record, err
	}
	defer file.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(nil, file, 8192))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil {
		return record, err
	}
	if record.Base != strings.TrimRight(base, "/") || record.Namespace != namespace || record.Instance == "" || record.PID <= 0 || !filepath.IsAbs(record.Socket) {
		return record, errors.New("runtime ownership identity mismatch")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return record, errors.New("runtime ownership record has trailing data")
	}
	return record, nil
}

// discoverResidentOwner verifies the record against a live socket response.
// The record is never a permission to signal a PID or remove a socket.
func discoverResidentOwner(ctx context.Context, base string) (string, error) {
	record, err := readResidentOwner(base)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if err := privateOwnedDirectory(filepath.Dir(record.Socket)); err != nil {
		return "", err
	}
	info, statErr := os.Lstat(record.Socket)
	if statErr == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || int(stat.Uid) != os.Getuid() || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0600 {
			return "", errors.New("unsafe runtime socket")
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return "", statErr
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://communicator.local/_comm/status", nil)
	client := unixClient(record.Socket, time.Second)
	client.Transport = &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		raw, err := (&net.Dialer{}).DialContext(ctx, "unix", record.Socket)
		if err != nil {
			return nil, err
		}
		if err := verifyResidentPeer(raw, record.PID); err != nil {
			raw.Close()
			return nil, err
		}
		return raw, nil
	}}
	response, err := client.Do(req)
	if err != nil {
		dir, _, coordErr := residentCoordination(base)
		if coordErr != nil {
			return "", coordErr
		}
		file, lockErr := os.OpenFile(filepath.Join(dir, "owner.lock"), os.O_RDWR|syscall.O_NOFOLLOW, 0)
		if lockErr != nil {
			return "", errors.New("runtime ownership lock is missing or unreadable")
		}
		defer file.Close()
		info, lockErr := file.Stat()
		if lockErr != nil {
			return "", lockErr
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || int(stat.Uid) != os.Getuid() || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
			return "", errors.New("unsafe runtime ownership lock")
		}
		if syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
			return "", errors.New("runtime owner unavailable while namespace remains occupied")
		}
		defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		return "", nil
	}
	defer response.Body.Close()
	var status struct {
		Instance string `json:"owner_instance_id"`
		PID      int    `json:"pid"`
		Protocol int    `json:"runtime_protocol"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, response.Body, 65536)).Decode(&status); err != nil {
		return "", err
	}
	if status.Instance != record.Instance || status.PID != record.PID || status.Protocol != residency.Protocol {
		return "", errors.New("live runtime ownership mismatch")
	}
	return record.Socket, nil
}

func resolvedRuntimeSocket(ctx context.Context, base string) (string, error) {
	socket, err := discoverResidentOwner(ctx, base)
	if err != nil {
		return "", err
	}
	if socket != "" {
		return socket, nil
	}
	return socketPath(base)
}

// claimResidentNamespace excludes owners across default-root changes. Existing
// legacy path locks are also held while the new owner runs. Custom roots keep
// their own namespace identity.
func claimResidentNamespace(base, socket string) (func(), error) {
	dir, namespace, err := residentCoordination(base)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0700); err != nil {
		return nil, err
	}
	if err := privateOwnedDirectory(filepath.Dir(dir)); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := privateOwnedDirectory(dir); err != nil {
		return nil, err
	}
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(dir, "owner.lock"))
	if err != nil {
		return nil, err
	}
	locks := []*ipc.Lock{lock}
	release := func() {
		for i := len(locks) - 1; i >= 0; i-- {
			locks[i].Release()
		}
	}
	if namespace == "default" {
		for _, root := range []string{sessionRuntimeRoot(), filepath.Join("/tmp", fmt.Sprintf("cxx-%d", os.Getuid()))} {
			if root == "" {
				continue
			}
			if err := privateOwnedDirectory(root); errors.Is(err, os.ErrNotExist) {
				continue
			} else if err != nil {
				release()
				return nil, err
			}
			candidate, err := socketPathIn(root, base, "")
			if err != nil {
				release()
				return nil, err
			}
			if candidate == socket {
				continue
			}
			legacy, err := ipc.TryAcquireExclusivePath(filepath.Join(filepath.Dir(candidate), "owner.lock"))
			if err != nil {
				release()
				return nil, fmt.Errorf("runtime namespace occupied on another path: %w", err)
			}
			locks = append(locks, legacy)
		}
	}
	record := residentOwnerRecord{Base: strings.TrimRight(base, "/"), Namespace: namespace, Socket: socket, Instance: processInstance, PID: os.Getpid()}
	body, _ := json.Marshal(record)
	file, err := os.CreateTemp(dir, ".owner-*")
	if err != nil {
		release()
		return nil, err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err = file.Write(body); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, filepath.Join(dir, "owner.json"))
	}
	if err == nil {
		parent, openErr := os.Open(dir)
		if openErr != nil {
			err = openErr
		} else {
			err = parent.Sync()
			parent.Close()
		}
	}
	if err != nil {
		release()
		return nil, err
	}
	return func() {
		if current, err := readResidentOwnerAt(base, dir, namespace, os.Getuid()); err == nil && current.Instance == processInstance {
			os.Remove(filepath.Join(dir, "owner.json"))
		}
		release()
	}, nil
}
