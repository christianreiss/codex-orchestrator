//go:build linux

package agentbus

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
	"github.com/google/uuid"
)

type migrationOwner struct {
	Instance  string `json:"owner_instance_id"`
	PID       int    `json:"pid"`
	Digest    string `json:"binary_sha256"`
	Namespace string `json:"namespace"`
	Protocol  int    `json:"runtime_protocol"`
}

type serviceMigration struct {
	directory, installed, unitPath, unit, seed, helper, candidate string
	account                                                       *user.User
	client                                                        *relayClient
	stdout, stderr                                                io.Writer
	process                                                       *residency.Process
	uid                                                           int
}

func (m *serviceMigration) manage(ctx context.Context, command string, j residency.Journal) (migrationOwner, error) {
	var owner migrationOwner
	f, err := os.Open(m.helper)
	if err != nil {
		return owner, err
	}
	defer f.Close()
	args := []string{"communicator", "migration", command, m.seed}
	if command != "inspect" {
		args = append(args, j.TransitionID, j.SourceOwner)
	}
	cmd := exec.CommandContext(ctx, "/proc/self/fd/3", args...)
	cmd.ExtraFiles = []*os.File{f}
	gid, err := strconv.Atoi(m.account.Gid)
	if err != nil {
		return owner, err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(m.uid), Gid: uint32(gid)}}
	// The system unit uses the default namespace. Caller login namespaces are
	// never imported. The signed seed contains all identity needed by discovery.
	cmd.Env = []string{"HOME=" + m.account.HomeDir, "PATH=/usr/local/bin:/usr/bin:/bin"}
	output, err := cmd.Output()
	if err != nil {
		return owner, fmt.Errorf("compatible owner %s unavailable: %w", command, err)
	}
	if command == "inspect" {
		err = json.Unmarshal(output, &owner)
		if err == nil && (owner.Instance == "" || owner.PID <= 0 || owner.Protocol != residency.Protocol || owner.Namespace != "default") {
			err = errors.New("incompatible resident namespace identity")
		}
	}
	return owner, err
}

func (m *serviceMigration) api(ctx context.Context, j residency.Journal, command string, ready bool) error {
	var view struct {
		RequestID string `json:"request_id"`
		Fenced    bool   `json:"fenced"`
		Ready     bool   `json:"ready"`
	}
	err := doJSON(ctx, m.client.http, m.client.baseURL, http.MethodPost, "/host/daemon/migration", map[string]string{"request_id": j.TransitionID, "command": command}, map[string]string{"X-API-Key": m.client.apiKey}, &view)
	if err != nil {
		return err
	}
	if view.RequestID != j.TransitionID || command != "release" && (!view.Fenced || ready && !view.Ready) {
		return errors.New("migration pending: remote accepted work or claims remain")
	}
	if command == "release" && view.Fenced {
		return errors.New("migration admission remains fenced")
	}
	return nil
}

func (m *serviceMigration) Stage(ctx context.Context, j residency.Journal) error {
	_, err := residency.StageBinary(fmt.Sprintf("/proc/%d/exe", j.SourcePID), filepath.Join(m.directory, "staged"), j.Source)
	if err != nil {
		return err
	}
	digest, err := residency.DigestFile(m.candidate)
	if err != nil || digest != j.Target {
		return errors.New("migration candidate bytes changed")
	}
	unitDigest, err := residency.DigestFile(m.unitPath)
	if err != nil || unitDigest != j.SourceUnit {
		return errors.New("migration source unit changed")
	}
	_, err = residency.StageBinary(m.unitPath, filepath.Join(m.directory, "staged"), j.SourceUnit)
	if err != nil {
		return err
	}
	// The candidate unit is immutable and journal-bound as well as the binary.
	candidate := filepath.Join(m.directory, "candidate-unit-"+j.TransitionID)
	if err := writeProtectedFileIfAbsentOrSame(candidate, []byte(m.unit)); err != nil {
		return err
	}
	_, err = residency.StageBinary(candidate, filepath.Join(m.directory, "staged"), j.TargetUnit)
	return err
}
func (m *serviceMigration) Fence(ctx context.Context, j residency.Journal) error {
	return m.api(ctx, j, "fence", false)
}
func (m *serviceMigration) Prepare(ctx context.Context, j residency.Journal) error {
	if err := m.api(ctx, j, "status", true); err != nil {
		return err
	}
	pid, err := serviceMainPID()
	if err != nil || pid != j.SourcePID {
		return errors.New("source service identity changed before preparation")
	}
	p, err := residency.PinProcess(pid, m.uid, j.Source)
	if err != nil {
		return err
	}
	if p.Start != j.SourceStart || p.Boot != j.SourceBoot {
		p.Close()
		return errors.New("source start/boot identity changed")
	}
	if m.process != nil {
		m.process.Close()
	}
	m.process = p
	_, err = m.manage(ctx, "prepare", j)
	return err
}
func (m *serviceMigration) Exit(ctx context.Context, j residency.Journal) error {
	if m.process == nil {
		p, err := residency.PinProcess(j.SourcePID, m.uid, j.Source)
		if err != nil {
			// Recovery can prove absence, but never treats a different extant process
			// or an unreadable /proc entry as the original source having safely exited.
			if _, statErr := os.Stat(fmt.Sprintf("/proc/%d", j.SourcePID)); errors.Is(statErr, os.ErrNotExist) {
				return nil
			}
			return fmt.Errorf("migration source exit is ambiguous: %w", err)
		}
		if p.Start != j.SourceStart || p.Boot != j.SourceBoot {
			p.Close()
			return errors.New("migration source identity changed")
		}
		m.process = p
	}
	_ = func() error { _, err := m.manage(ctx, "commit", j); return err }()
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return m.process.WaitExited(wait)
}
func (m *serviceMigration) Install(ctx context.Context, j residency.Journal) (string, error) {
	// A previously started target is inspected, never restarted just because
	// recording its identity was interrupted.
	pid, err := serviceMainPID()
	if err != nil {
		return "", err
	}
	if pid != 0 {
		owner, err := m.verifyOwner(ctx, j.Target)
		if err != nil {
			return "", err
		}
		return owner.Instance, nil
	}
	source, err := residency.DigestFile(m.installed)
	if err != nil {
		return "", err
	}
	if source != j.Source && source != j.Target {
		return "", errors.New("installed service binary changed outside migration")
	}
	body, err := os.ReadFile(filepath.Join(m.directory, "staged", "cxx-"+j.Target))
	if err != nil {
		return "", err
	}
	if err := replaceServiceBinary(m.installed, body); err != nil {
		return "", err
	}
	if _, err := writeProtectedFileIfChanged(m.unitPath, []byte(m.unit)); err != nil {
		return "", err
	}
	for _, args := range [][]string{{"daemon-reload"}, {"enable", "cxx-daemon.service"}, {"start", "cxx-daemon.service"}} {
		if err := runServiceProcess(m.stdout, m.stderr, "systemctl", args...); err != nil {
			return "", err
		}
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		owner, err := m.verifyOwner(ctx, j.Target)
		if err == nil {
			return owner.Instance, nil
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return "", errors.New("target service verification failed; admission remains fenced and rollback artifacts retained")
}
func (m *serviceMigration) verifyOwner(ctx context.Context, digest string) (migrationOwner, error) {
	owner, err := m.manage(ctx, "inspect", residency.Journal{})
	if err != nil {
		return owner, err
	}
	pid, err := serviceMainPID()
	if err != nil || pid != owner.PID || owner.Digest != digest {
		return owner, errors.New("target service PID/executable mismatch")
	}
	process, err := residency.PinProcess(pid, m.uid, digest)
	if err != nil {
		return owner, err
	}
	defer process.Close()
	unitDigest := sha256.Sum256([]byte(m.unit))
	actual, err := residency.DigestFile(m.unitPath)
	if err != nil || actual != hex.EncodeToString(unitDigest[:]) {
		return owner, errors.New("target unit mismatch")
	}
	return owner, nil
}
func (m *serviceMigration) Verify(ctx context.Context, j residency.Journal) error {
	owner, err := m.verifyOwner(ctx, j.Target)
	if err == nil && owner.Instance != j.TargetOwner {
		return errors.New("target instance changed before admission release")
	}
	return err
}
func (m *serviceMigration) Release(ctx context.Context, j residency.Journal) error {
	return m.api(ctx, j, "release", false)
}

func writeProtectedFileIfAbsentOrSame(path string, body []byte) error {
	if old, err := os.ReadFile(path); err == nil {
		if string(old) != string(body) {
			return errors.New("migration candidate unit differs from pending transaction")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return writeProtectedFile(path, body)
}

func migrateResidentService(configs map[string]*config.Config, client *relayClient, settings daemonSettings, account *user.User, installed, unit string, stdout, stderr io.Writer) error {
	dir := filepath.Join(filepath.Dir(installed), "migration")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(dir, "operation.lock"))
	if err != nil {
		return err
	}
	defer lock.Release()
	uid, err := strconv.Atoi(account.Uid)
	if err != nil {
		return err
	}
	seed := ""
	for _, engine := range []string{"codex", "claude", "grok"} {
		if cfg := configs[engine]; cfg != nil {
			seed = cfg.SourcePath()
			break
		}
	}
	if seed == "" {
		return errors.New("signed migration seed unavailable")
	}
	target, err := residency.DigestFile("/proc/self/exe")
	if err != nil {
		return err
	}
	helper, err := residency.StageBinary("/proc/self/exe", filepath.Join(dir, "staged"), target)
	if err != nil {
		return err
	}
	if direct, ok := communicator.Direct(client.http.Transport); ok {
		client.http.Transport = direct
	}
	m := &serviceMigration{directory: dir, installed: installed, unitPath: daemonUnitPath, unit: unit, seed: seed, helper: helper, candidate: helper, account: account, client: client, stdout: stdout, stderr: stderr, uid: uid}
	defer func() {
		if m.process != nil {
			m.process.Close()
		}
	}()
	// Custom systemd runtime namespaces must be explicitly retained, not silently
	// overwritten with a caller's or the default namespace.
	environment, err := exec.Command("systemctl", "show", "--property=Environment", "--value", "cxx-daemon.service").Output()
	if err != nil {
		return err
	}
	if strings.Contains(string(environment), "XDG_RUNTIME_DIR=") {
		return errors.New("migration pending: custom systemd runtime namespace requires an explicitly preserved unit")
	}
	path := filepath.Join(dir, "transition.json")
	j, readErr := residency.ReadJournal(path)
	if readErr == nil && j.Phase == residency.Reopened {
		if j.Target == target && j.TargetUnit == digestBytes([]byte(unit)) {
			if _, err := m.verifyOwner(context.Background(), target); err == nil {
				return nil
			}
		}
		if err := os.Rename(path, filepath.Join(dir, j.TransitionID+".json")); err != nil {
			return err
		}
		if err := os.Remove(filepath.Join(dir, "candidate-unit")); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		readErr = os.ErrNotExist
	}
	if errors.Is(readErr, os.ErrNotExist) {
		pid, err := serviceMainPID()
		if err != nil {
			return err
		}
		if pid == 0 {
			return errors.New("inactive resident service uses the fresh-install path")
		}
		owner, err := m.manage(context.Background(), "inspect", residency.Journal{})
		if err != nil {
			return fmt.Errorf("migration deferred for incompatible or unresponsive owner: %w", err)
		}
		if owner.PID != pid {
			return errors.New("systemd process is not the discovered runtime owner")
		}
		source, err := residency.DigestFile(fmt.Sprintf("/proc/%d/exe", pid))
		if err != nil {
			return err
		}
		process, err := residency.PinProcess(pid, uid, source)
		if err != nil {
			return err
		}
		defer process.Close()
		sourceUnit, err := residency.DigestFile(daemonUnitPath)
		if err != nil {
			return err
		}
		j = residency.Journal{TransitionID: uuid.NewString(), Source: source, Target: target, SourceOwner: owner.Instance, SourcePID: pid, SourceStart: process.Start, SourceBoot: process.Boot, Namespace: owner.Namespace, SourceUnit: sourceUnit, TargetUnit: digestBytes([]byte(unit)), Phase: residency.Observed}
		if err := residency.CreateJournal(path, j); err != nil {
			return err
		}
	} else if readErr != nil {
		return readErr
	}
	if j.Target != target || j.TargetUnit != digestBytes([]byte(unit)) {
		return errors.New("another binary or unit has a pending migration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err = residency.ContinueTransition(ctx, path, m)
	return err
}

func digestBytes(body []byte) string { sum := sha256.Sum256(body); return hex.EncodeToString(sum[:]) }

// Rollback is a reverse migration of a completed compatible transition, with
// its own durable ID. Repeating it reconciles the same target rather than
// toggling versions or replaying work.
func rollbackResidentService(stdout, stderr io.Writer) error {
	if os.Geteuid() != 0 {
		return errors.New("system daemon rollback requires root")
	}
	if !residentConfigurationEnabled() {
		return errors.New("rollback pending: keep the compatible signed runtime capability enabled until the reverse handoff is verified")
	}
	configs, client, settings, err := daemonConfig(context.Background())
	if err != nil {
		return err
	}
	account, err := user.Lookup(settings.Username)
	if err != nil {
		return err
	}
	uid, err := strconv.Atoi(account.Uid)
	if err != nil {
		return err
	}
	installed := "/usr/local/lib/cxx-daemon/cxx"
	dir := filepath.Join(filepath.Dir(installed), "migration")
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(dir, "operation.lock"))
	if err != nil {
		return err
	}
	defer lock.Release()
	forward, err := residency.ReadJournal(filepath.Join(dir, "transition.json"))
	if err != nil {
		return err
	}
	if forward.Phase != residency.Reopened {
		return errors.New("complete or reconcile the pending forward migration before rollback")
	}
	unitPath := filepath.Join(dir, "staged", "cxx-"+forward.SourceUnit)
	unitBody, err := os.ReadFile(unitPath)
	if err != nil {
		return err
	}
	if digestBytes(unitBody) != forward.SourceUnit {
		return errors.New("rollback unit artifact changed")
	}
	candidate := filepath.Join(dir, "staged", "cxx-"+forward.Source)
	if digest, err := residency.DigestFile(candidate); err != nil || digest != forward.Source {
		return errors.New("rollback executable artifact changed")
	}
	helperDigest, err := residency.DigestFile("/proc/self/exe")
	if err != nil {
		return err
	}
	helper, err := residency.StageBinary("/proc/self/exe", filepath.Join(dir, "staged"), helperDigest)
	if err != nil {
		return err
	}
	seed := ""
	for _, engine := range []string{"codex", "claude", "grok"} {
		if cfg := configs[engine]; cfg != nil {
			seed = cfg.SourcePath()
			break
		}
	}
	if seed == "" {
		return errors.New("signed rollback seed unavailable")
	}
	if direct, ok := communicator.Direct(client.http.Transport); ok {
		client.http.Transport = direct
	}
	m := &serviceMigration{directory: dir, installed: installed, unitPath: daemonUnitPath, unit: string(unitBody), seed: seed, helper: helper, candidate: candidate, account: account, client: client, stdout: stdout, stderr: stderr, uid: uid}
	defer func() {
		if m.process != nil {
			m.process.Close()
		}
	}()
	path := filepath.Join(dir, "rollback-"+forward.TransitionID+".json")
	j, readErr := residency.ReadJournal(path)
	if readErr == nil && j.Phase == residency.Reopened {
		_, err := m.verifyOwner(context.Background(), j.Target)
		return err
	}
	if errors.Is(readErr, os.ErrNotExist) {
		owner, err := m.manage(context.Background(), "inspect", residency.Journal{})
		if err != nil {
			return err
		}
		pid, err := serviceMainPID()
		if err != nil || pid != owner.PID {
			return errors.New("rollback source is not the service owner")
		}
		digest, err := residency.DigestFile(fmt.Sprintf("/proc/%d/exe", pid))
		if err != nil {
			return err
		}
		process, err := residency.PinProcess(pid, uid, digest)
		if err != nil {
			return err
		}
		defer process.Close()
		sourceUnit, err := residency.DigestFile(daemonUnitPath)
		if err != nil {
			return err
		}
		j = residency.Journal{TransitionID: uuid.NewString(), Source: digest, Target: forward.Source, SourceOwner: owner.Instance, SourcePID: pid, SourceStart: process.Start, SourceBoot: process.Boot, Namespace: owner.Namespace, SourceUnit: sourceUnit, TargetUnit: forward.SourceUnit, Phase: residency.Observed}
		if err := residency.CreateJournal(path, j); err != nil {
			return err
		}
	} else if readErr != nil {
		return readErr
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err = residency.ContinueTransition(ctx, path, m)
	return err
}
