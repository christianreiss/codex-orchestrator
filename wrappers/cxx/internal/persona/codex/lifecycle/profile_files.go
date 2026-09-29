package lifecycle

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// Codex >= 0.156.1 refuses `--profile <name>` while config.toml carries
// [profiles.*] and instead layers $CODEX_HOME/<name>.config.toml. The server
// ships each fleet profile as one of those files; this writes them.
//
// The manifest is what makes pruning safe: only a file the fleet itself wrote is
// ever removed, so a user-authored foo.config.toml is never touched, and a file
// the user already had under a fleet profile's name is not overwritten either.
var profileFileName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

type profileManifest struct {
	Names []string `json:"names"`
}

func profilePath(home, name string) string { return filepath.Join(home, name+".config.toml") }

// syncProfileFiles makes home hold exactly the fleet's profiles among the files
// it owns. It reports whether anything on disk changed.
func syncProfileFiles(home string, profiles []orchestrator.ConfigProfile) (bool, error) {
	owned := codex.ManagedProfileNames(home)
	want := map[string]bool{}
	changed := false
	var errs []error

	for _, p := range profiles {
		if !profileFileName.MatchString(p.Name) {
			errs = append(errs, fmt.Errorf("profile %q is not a safe file name; skipped", p.Name))
			continue
		}
		dst := profilePath(home, p.Name)
		if _, err := os.Stat(dst); err == nil && !owned[p.Name] && fileDigest(dst) != p.SHA256 {
			errs = append(errs, fmt.Errorf("%s exists and is not fleet-managed; left alone", filepath.Base(dst)))
			continue
		}
		want[p.Name] = true
		if fileDigest(dst) == p.SHA256 {
			continue
		}
		if err := atomicWrite(dst, []byte(p.Content), 0o644); err != nil {
			errs = append(errs, err)
			delete(want, p.Name)
			continue
		}
		changed = true
	}

	for name := range owned {
		if want[name] {
			continue
		}
		if err := os.Remove(profilePath(home, name)); err == nil {
			changed = true
		} else if !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
			want[name] = true // still on disk: keep owning it so the next sync retries
		}
	}

	names := make([]string, 0, len(want))
	for name := range want {
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) != len(owned) || !sameNames(owned, names) {
		body, _ := json.Marshal(profileManifest{Names: names})
		if err := atomicWrite(filepath.Join(home, codex.ProfileManifestFile), append(body, '\n'), 0o600); err != nil {
			errs = append(errs, err)
		}
	}
	return changed, errors.Join(errs...)
}

func sameNames(owned map[string]bool, names []string) bool {
	for _, n := range names {
		if !owned[n] {
			return false
		}
	}
	return true
}
