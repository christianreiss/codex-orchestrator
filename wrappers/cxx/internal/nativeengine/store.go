// Package nativeengine holds the native-CLI store and runtime helpers shared by
// the subscription engines (Grok, Kimi Code). Each engine keeps its own
// install source, verification, native config, auth projection and broker;
// only the engine-neutral plumbing lives here.
package nativeengine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/enginestore"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeentry"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/skillstore"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
)

// VersionPattern matches a native CLI semantic version.
var VersionPattern = regexp.MustCompile(`\b([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)\b`)

// Store describes one engine's native CLI store. The on-disk names it derives
// are pinned per engine by tests:
//
//	~/.<Persona>/state, <state>/<Binary>-bin, ~/.cxx/engines/<Binary>,
//	<home>/bin/<Binary>, <home>/.<Persona>-sessions.lock, .<Persona>- temp files
type Store struct {
	Label         string // engine name in messages and the Skill store, e.g. "Grok"
	Binary        string // native executable and vendor name, e.g. "grok"
	Persona       string // wrapper persona, e.g. "cgx"
	BinEnv        string // operator override for the native CLI path
	PinnedVersion string // minimum supported native version
	Home          func() (string, error)
	NativeEnv     func([]string) []string
}

// SupportedVersion enforces the same native config baseline as the API.
// A prerelease of the baseline itself does not yet satisfy that release.
func (s *Store) SupportedVersion(version string) bool {
	if VersionPattern.FindString(version) != version || version == "" {
		return false
	}
	base := strings.SplitN(version, "+", 2)[0]
	numeric := strings.SplitN(base, "-", 2)[0]
	parts, minimum := strings.Split(numeric, "."), strings.Split(s.PinnedVersion, ".")
	for i := range minimum {
		value, err := strconv.Atoi(parts[i])
		floor, _ := strconv.Atoi(minimum[i])
		if err != nil {
			return false
		}
		if value != floor {
			return value > floor
		}
	}
	return !strings.Contains(base, "-")
}

// CoerceVersionToMinimum heals older server pins while preserving newer pins.
func (s *Store) CoerceVersionToMinimum(version string) string {
	if version == "" || (VersionPattern.FindString(version) == version && !s.SupportedVersion(version)) {
		return s.PinnedVersion
	}
	return version
}

func (s *Store) StateDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "."+s.Persona, "state"), nil
}

// Skills is the native on-disk store for fleet Skills (<home>/skills/<name>/
// SKILL.md) with its ownership manifest in the persona state.
func (s *Store) Skills() (skillstore.Store, error) {
	home, err := s.Home()
	if err != nil {
		return skillstore.Store{}, err
	}
	state, err := s.StateDir()
	if err != nil {
		return skillstore.Store{}, err
	}
	return skillstore.Store{Root: filepath.Join(home, "skills"), ManifestPath: filepath.Join(state, "skills.json"), Label: s.Label}, nil
}

// Dir is the private version store under ~/.cxx/engines.
func (s *Store) Dir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cxx", "engines", s.Binary), nil
}

func (s *Store) FindCLI() (string, error) {
	var candidates []string
	if value := strings.TrimSpace(os.Getenv(s.BinEnv)); value != "" {
		candidates = append(candidates, value)
	}
	if state, err := s.StateDir(); err == nil {
		if raw, err := os.ReadFile(filepath.Join(state, s.Binary+"-bin")); err == nil {
			candidates = append(candidates, strings.TrimSpace(string(raw)))
		}
	}
	if home, err := s.Home(); err == nil {
		candidates = append(candidates, filepath.Join(home, "bin", s.Binary+exeSuffix))
	}
	currentExe, _ := os.Executable()
	if path, err := nativeentry.ResolveVendor(s.Binary, currentExe); err == nil {
		candidates = append(candidates, path)
	}
	self, _ := os.Executable()
	self, _ = filepath.EvalSymlinks(self)
	for _, path := range candidates {
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil || resolved == self || nativeentry.IsWrapperOrShim(path, currentExe) {
			continue
		}
		st, err := os.Stat(resolved)
		if err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0o111 != 0 {
			return resolved, nil
		}
	}
	return "", errors.New(s.Label + " CLI missing; run " + s.Persona + " update")
}

func (s *Store) ProbeVersion(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Env = s.NativeEnv(os.Environ())
	out, err := cmd.Output()
	if err != nil {
		return "", errors.New(s.Label + " version probe failed")
	}
	match := VersionPattern.FindStringSubmatch(string(out))
	if len(match) != 2 {
		return "", errors.New(s.Label + " version probe returned no version")
	}
	return match[1], nil
}

func SetEnv(env []string, key, value string) []string {
	out := make([]string, 0, len(env)+1)
	for _, item := range env {
		if !strings.HasPrefix(item, key+"=") {
			out = append(out, item)
		}
	}
	return append(out, key+"="+value)
}

func (s *Store) Download(ctx context.Context, client *http.Client, location string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s package download HTTP %d", s.Label, resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(updateprogress.Reader(ctx, resp.Body, resp.ContentLength), limit+1))
	if err == nil && int64(len(raw)) > limit {
		err = errors.New(s.Label + " package exceeds download limit")
	}
	return raw, err
}

// TryAcquireMaintenance is scoped to the original native home, even though
// credentials themselves live in isolated homes. No remote or local removal
// precedes it.
func (s *Store) TryAcquireMaintenance(baseHome string) (*ipc.Lock, error) {
	return ipc.TryAcquireExclusivePath(filepath.Join(baseHome, "."+s.Persona+"-sessions.lock"))
}

func (s *Store) Prune(pressure bool) error {
	home, err := s.Home()
	if err != nil {
		return err
	}
	guard, err := s.TryAcquireMaintenance(home)
	if errors.Is(err, ipc.ErrHeld) {
		return nil
	}
	if err != nil {
		return err
	}
	defer guard.Release()
	root, err := s.Dir()
	if err != nil {
		return err
	}
	_, err = enginestore.PruneEngineResolved(root, "install.lock", nil, s.FindCLI, pressure)
	return err
}

func (s *Store) RemoveInstalledCopies(ctx context.Context) error {
	root, err := s.Dir()
	if err != nil {
		return err
	}
	return enginestore.Uninstall(ctx, root, "install.lock")
}

func (s *Store) AtomicWrite(path string, raw []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "."+s.Persona+"-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
