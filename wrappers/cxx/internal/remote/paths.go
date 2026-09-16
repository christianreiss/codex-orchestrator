package remote

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// homeEnv overrides where remote state lives, on either side of the
// connection. It is the only such override on purpose: every extra branch in
// this file is another way for two invocations to disagree about which mux
// socket or which job store they share, and disagreeing silently is worse than
// any path it could pick.
const homeEnv = "CXX_REMOTE_HOME"

// Deliberately not $XDG_RUNTIME_DIR. systemd-logind removes /run/user/<uid>
// when the user's last session ends, and an `ssh host cmd` session ending is
// the normal case here — the mux socket and the job store would vanish under a
// job that is still running, and the next call would find nothing and start a
// second one. $HOME survives logout and reboot.
func Home() (string, error) {
	if override := strings.TrimSpace(os.Getenv(homeEnv)); override != "" {
		return ensureDir(override)
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return "", failf(CodeNoHome, "cannot resolve a home directory; set %s", homeEnv)
	}
	return ensureDir(filepath.Join(home, ".cxx", "remote"))
}

func ensureDir(path string) (string, error) {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return "", failf(CodeIO, "create %s: %v", path, err)
	}
	// MkdirAll honours the umask and does nothing at all to a directory that
	// already exists, so neither case is guaranteed to be 0700 without this.
	if err := os.Chmod(path, 0o700); err != nil {
		return "", failf(CodeIO, "protect %s: %v", path, err)
	}
	return path, nil
}

func subdir(parts ...string) (string, error) {
	home, err := Home()
	if err != nil {
		return "", err
	}
	return ensureDir(filepath.Join(append([]string{home}, parts...)...))
}

// JobsDir holds one directory per job. JobDir deliberately does not create it:
// creating it is how a job start claims its id, and that has to be the
// exclusive O_EXCL mkdir in jobstore.go rather than an incidental MkdirAll.
func JobsDir() (string, error) { return subdir("jobs") }

func JobDir(id string) (string, error) {
	jobs, err := JobsDir()
	if err != nil {
		return "", err
	}
	if err := ValidJobID(id); err != nil {
		return "", err
	}
	return filepath.Join(jobs, id), nil
}

// BinDir is content-addressed by the artifact digest so an upgrade never
// overwrites a binary a running job's supervisor still has mapped.
func BinDir(sha string) (string, error) { return subdir("bin", sha) }

func ArtifactsDir() (string, error) { return subdir("artifacts") }

func JournalDir() (string, error) { return subdir("journal") }

func TmpDir() (string, error) { return subdir("tmp") }

// unixPathMax is the usable length of sockaddr_un.sun_path. Exceeding it fails
// with a bare EINVAL that names nothing, which is why this package checks and
// reports the number itself.
func unixPathMax() int {
	if runtime.GOOS == "darwin" {
		return 104
	}
	return 108
}

// MuxPath returns the ControlPath for one ssh identity.
//
// Always ours, never the user's. If ~/.ssh/config sets ControlMaster auto, an
// inherited path would make this process either a client of the user's master —
// dying whenever they run `ssh -O exit` — or the master for their interactive
// shells, which would then die with our ControlPersist. Neither is acceptable
// for either party.
//
// The directory is short by design: the assembled path is a sockaddr_un.
func MuxPath(identity string) (string, error) {
	dir, err := subdir("m")
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(identity))
	path := filepath.Join(dir, hex.EncodeToString(sum[:4]))
	if limit := unixPathMax(); len(path) > limit {
		return "", failf(CodePathTooLong,
			"ssh control path is %d bytes, over the %d-byte limit for a unix socket: %s (set %s to something shorter)",
			len(path), limit, path, homeEnv)
	}
	return path, nil
}

// ValidJobID keeps a caller-chosen id inside one path segment. The id names a
// directory the remote side creates, so a separator or a dot-dot here is a
// write outside the job store.
func ValidJobID(id string) error {
	if id == "" {
		return failf(CodeUsage, "job id is required")
	}
	if len(id) > 64 {
		return failf(CodeUsage, "job id is longer than 64 characters")
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-' || r == '_' || r == '.':
		default:
			return failf(CodeUsage, "job id %q may only contain letters, digits, '-', '_' and '.'", id)
		}
	}
	if id == "." || id == ".." || strings.HasPrefix(id, ".") {
		return failf(CodeUsage, "job id %q may not start with a dot", id)
	}
	return nil
}
