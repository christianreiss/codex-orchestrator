package agentbus

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	coreupdate "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
	"github.com/google/uuid"
)

// The resident service runs from a root-owned copy the unprivileged updater
// cannot replace. It asks for the replacement by writing a request into a
// directory owned by the service user; a root oneshot, started by a systemd path
// unit, verifies the request against the signed configuration itself and runs
// the existing journaled `daemon install` migration from a root-owned copy.
const (
	residentUpdateRequestDir  = "/var/lib/cxx-daemon/requests"
	residentUpdateRequestFile = residentUpdateRequestDir + "/update.json"
	residentUpdatePathUnit    = "/etc/systemd/system/cxx-daemon-update.path"
	residentUpdateServiceUnit = "/etc/systemd/system/cxx-daemon-update.service"
)

// ResidentUpdateRequest names the target and where the verified bytes are. The
// path is only a hint: the root helper accepts the bytes solely by digest.
type ResidentUpdateRequest struct {
	RequestID string `json:"request_id"`
	Version   string `json:"version"`
	SHA256    string `json:"sha256"`
	Source    string `json:"source"`
}

// RequestResidentUpdate is called by the resident updater as the service user.
func RequestResidentUpdate(version, sha, source string) error {
	info, err := os.Lstat(residentUpdateRequestDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("resident update handoff is not installed; run 'sudo cxx daemon install'")
	}
	body, err := json.Marshal(ResidentUpdateRequest{RequestID: uuid.NewString(), Version: version, SHA256: strings.ToLower(sha), Source: source})
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(residentUpdateRequestDir, ".update-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), residentUpdateRequestFile)
}

// residentUpdateUnits renders the root path/oneshot pair. The oneshot inherits
// the service's HOME and signed config paths so it reads the same configs.
func residentUpdateUnits(environment, installed string) (pathUnit, serviceUnit string) {
	pathUnit = fmt.Sprintf("[Unit]\nDescription=Codex Orchestrator resident update handoff\n[Path]\nPathChanged=%s\nUnit=cxx-daemon-update.service\n[Install]\nWantedBy=multi-user.target\n", residentUpdateRequestFile)
	serviceUnit = fmt.Sprintf("[Unit]\nDescription=Codex Orchestrator resident update handoff (root)\n[Service]\nType=oneshot\n%sExecStart=%s daemon apply-update\nUMask=0077\n", environment, systemdQuote(installed))
	return pathUnit, serviceUnit
}

// installResidentUpdateHandoff creates the request directory for the service
// user and enables the path unit. Called from root `daemon install`.
func installResidentUpdateHandoff(account *user.User, environment, installed string, stdout, stderr io.Writer) error {
	uid, err := strconv.Atoi(account.Uid)
	if err != nil {
		return err
	}
	gid, err := strconv.Atoi(account.Gid)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(residentUpdateRequestDir, 0o700); err != nil {
		return err
	}
	if info, err := os.Lstat(residentUpdateRequestDir); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("unsafe resident update request directory")
	}
	if err := os.Chown(residentUpdateRequestDir, uid, gid); err != nil {
		return err
	}
	if err := os.Chmod(residentUpdateRequestDir, 0o700); err != nil {
		return err
	}
	pathUnit, serviceUnit := residentUpdateUnits(environment, installed)
	if _, err := writeProtectedFileIfChanged(residentUpdateServiceUnit, []byte(serviceUnit)); err != nil {
		return err
	}
	if _, err := writeProtectedFileIfChanged(residentUpdatePathUnit, []byte(pathUnit)); err != nil {
		return err
	}
	if err := runServiceProcess(stdout, stderr, "systemctl", "daemon-reload"); err != nil {
		return err
	}
	return runServiceProcess(stdout, stderr, "systemctl", "enable", "--now", "cxx-daemon-update.path")
}

// applyResidentUpdate is the root oneshot. It trusts nothing in the request
// except as a candidate: the signed config (verified with the baked key, not
// expired) must name exactly that version and digest, the version must be newer
// than the running service binary, and the bytes are copied into a root-owned
// staging directory and re-hashed before anything is executed as root.
func applyResidentUpdate(running string, stdout, stderr io.Writer) error {
	info, err := os.Lstat(residentUpdateRequestFile)
	if errors.Is(err, os.ErrNotExist) {
		return nil // the path unit also fires on removal
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("resident update request is not a regular file")
	}
	unit, err := os.ReadFile(daemonUnitPath)
	if err != nil {
		return fmt.Errorf("read service unit: %w", err)
	}
	owner, err := unitUser(string(unit))
	if err != nil {
		return err
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || strconv.FormatUint(uint64(stat.Uid), 10) != owner.Uid {
		return errors.New("resident update request is not owned by the service user")
	}
	raw, err := os.ReadFile(residentUpdateRequestFile)
	if err != nil {
		return err
	}
	var req ResidentUpdateRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return fmt.Errorf("invalid resident update request: %w", err)
	}
	key, err := signing.PublicKey()
	if err != nil {
		return err
	}
	var signed *config.Config
	for _, engine := range []string{config.EngineCodex, config.EngineClaude, config.EngineGrok} {
		path, err := config.DefaultPathForEngine(engine)
		if err != nil {
			continue
		}
		// LoadForEngine rejects an expired config, so an older but still
		// signed config cannot be replayed once it has expired.
		if cfg, err := config.LoadForEngine(path, key, false, engine); err == nil {
			signed = cfg
			break
		}
	}
	if signed == nil {
		return errors.New("no valid signed config to verify the resident update")
	}
	if cmp, err := coreupdate.CompareVersions(signed.Wrapper.Version, req.Version); err != nil || cmp != 0 || !strings.EqualFold(signed.Wrapper.BinarySHA256, req.SHA256) {
		return errors.New("resident update request does not match the signed wrapper target")
	}
	if cmp, err := coreupdate.CompareVersions(req.Version, running); err != nil || cmp <= 0 {
		return errors.New("resident update refuses a target that is not newer (use cxx communicator rollback)")
	}
	staged, err := residency.StageBinary(req.Source, filepath.Join(filepath.Dir("/usr/local/lib/cxx-daemon/cxx"), "staged"), strings.ToLower(req.SHA256))
	if err != nil {
		return fmt.Errorf("stage resident update: %w", err)
	}
	cmd := exec.Command(staged, "daemon", "install")
	cmd.Stdout, cmd.Stderr, cmd.Env = stdout, stderr, os.Environ()
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("resident update install: %w", err)
	}
	return os.Remove(residentUpdateRequestFile)
}

func unitUser(unit string) (*user.User, error) {
	for _, line := range strings.Split(unit, "\n") {
		if name, ok := strings.CutPrefix(strings.TrimSpace(line), "User="); ok {
			return user.Lookup(strings.TrimSpace(name))
		}
	}
	return nil, errors.New("service unit names no user")
}
