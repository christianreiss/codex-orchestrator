package layout

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// LauncherStatus contains paths and diagnosis only, never script contents or
// embedded credentials. Repair is limited to the generated transition scripts.
type LauncherStatus struct {
	Name, Path, State, Detail string
}

// CheckLaunchers diagnoses the commands the shell actually resolves. With fix,
// publish cxx if missing and migrate recognized scripts under the layout lock.
// Unknown files and commands belonging to another installation stay untouched.
func CheckLaunchers(ctx context.Context, executable string, engines []string, fix bool) ([]LauncherStatus, error) {
	canonical, err := CanonicalExecutable(executable)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(canonical); err != nil || info.IsDir() || filepath.Base(canonical) != "cxx" {
		return nil, fmt.Errorf("canonical cxx unavailable: %s", canonical)
	}
	var statuses []LauncherStatus
	check := func() error {
		published := ""
		var errs error
		if fix {
			published, errs = ensurePathVisible(canonical)
		}
		common := LauncherStatus{Name: "cxx", State: "healthy", Path: canonical}
		if path, err := exec.LookPath("cxx"); err != nil {
			common.State, common.Detail = "missing", "cxx is absent from PATH"
		} else {
			common.Path = path
			if !samePath(path, canonical) {
				common.State, common.Detail = "foreign", "PATH resolves to another installation; preserved"
			} else if published != "" {
				common.State, common.Detail = "repaired", "published current cxx on PATH"
			}
		}
		statuses = append(statuses, common)
		for _, engine := range normalizeEngines(engines) {
			name := aliasForEngine(engine)
			s := LauncherStatus{Name: name, State: "healthy"}
			path, err := exec.LookPath(name)
			s.Path = path
			switch {
			case err != nil:
				s.State, s.Detail = "missing", "command is absent from PATH"
			case samePath(path, canonical):
			default:
				info, statErr := os.Lstat(path)
				var body []byte
				if statErr == nil && info.Mode().IsRegular() && info.Size() <= 64*1024 {
					body, err = os.ReadFile(path)
				}
				if err != nil || !isTransitionScript(string(body), name) {
					s.State, s.Detail = "foreign", "unrecognized launcher or another installation; preserved"
				} else {
					s.State, s.Detail = "stale", "legacy transition script embeds installation-time credentials"
					if !samePath(filepath.Join(filepath.Dir(path), "cxx"), canonical) {
						s.Detail += "; sibling cxx does not target this artifact; preserved"
					} else if fix {
						if err := healTransitionShim(canonical, name); err != nil {
							errs = errors.Join(errs, fmt.Errorf("repair %s: %w", path, err))
						} else if samePath(path, canonical) {
							s.State, s.Detail = "repaired", "replaced legacy transition script with current cxx link"
						}
					}
				}
			}
			statuses = append(statuses, s)
		}
		return errs
	}
	if fix {
		err = WithTargetLock(ctx, canonical, check)
	} else {
		err = check()
	}
	return statuses, err
}
