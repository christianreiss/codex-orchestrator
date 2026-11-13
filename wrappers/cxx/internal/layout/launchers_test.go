package layout

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLauncherDoctorDryRunRepairAndIdempotence(t *testing.T) {
	for _, engine := range []string{EngineCodex, EngineClaude, EngineGrok, EngineKimi} {
		for _, format := range []string{"shim", "launcher"} {
			t.Run(engine+"/"+format, func(t *testing.T) {
				_, binDir, canonical := newShimInstall(t)
				name := aliasForEngine(engine)
				path := filepath.Join(binDir, name)
				mode := "INSTALL_MODE=shim"
				if format == "launcher" {
					mode = "INSTALL_CONTEXT=transition"
				}
				body := "#!/bin/sh\n# Codex Orchestrator legacy transition " + format + " for " + name + ".\nNAME='" + name + "'\n" + mode + "\nHOST_API_KEY='must-not-appear-in-diagnostics'\n"
				if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(canonical, filepath.Join(binDir, "cxx")); err != nil {
					t.Fatal(err)
				}
				for _, step := range []struct {
					fix   bool
					state string
				}{{false, "stale"}, {true, "repaired"}, {true, "healthy"}} {
					statuses, err := CheckLaunchers(context.Background(), canonical, []string{engine}, step.fix)
					if err != nil || len(statuses) != 2 || statuses[1].State != step.state {
						t.Fatalf("fix=%v statuses=%+v err=%v", step.fix, statuses, err)
					}
					for _, s := range statuses {
						if strings.Contains(s.Detail, "must-not-appear-in-diagnostics") {
							t.Fatal("embedded credential leaked")
						}
					}
					if !step.fix {
						if got, _ := os.ReadFile(path); string(got) != body {
							t.Fatal("diagnosis changed the launcher")
						}
					} else if got, err := os.Readlink(path); err != nil || got != canonical {
						t.Fatalf("repaired target=%q err=%v", got, err)
					}
				}
			})
		}
	}
}

func TestLauncherDoctorPreservesForeignEntries(t *testing.T) {
	for _, kind := range []string{"custom", "other-cxx", "symlink", "wrong-name", "wrong-mode"} {
		t.Run(kind, func(t *testing.T) {
			_, binDir, canonical := newShimInstall(t)
			path := filepath.Join(binDir, "cdx")
			body := "#!/bin/sh\n# Codex Orchestrator legacy transition launcher for cdx.\nNAME='cdx'\nINSTALL_CONTEXT=transition\n"
			switch kind {
			case "custom":
				body = "#!/bin/sh\necho custom launcher\n"
			case "wrong-name":
				body = strings.ReplaceAll(body, "NAME='cdx'", "NAME='clx'")
			case "wrong-mode":
				body = strings.ReplaceAll(body, "INSTALL_CONTEXT=transition", "INSTALL_CONTEXT=installer")
			}
			if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
				t.Fatal(err)
			}
			target := canonical
			if kind == "other-cxx" || kind == "symlink" {
				target = filepath.Join(t.TempDir(), "cxx")
				if err := os.WriteFile(target, []byte("other install"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			if kind == "symlink" {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(target, filepath.Join(binDir, "cxx")); err != nil {
				t.Fatal(err)
			}
			before, _ := os.Lstat(path)
			statuses, err := CheckLaunchers(context.Background(), canonical, []string{EngineCodex}, true)
			if err != nil || len(statuses) != 2 || statuses[1].State == "repaired" || statuses[1].State == "healthy" {
				t.Fatalf("statuses=%+v err=%v", statuses, err)
			}
			after, _ := os.Lstat(path)
			if !os.SameFile(before, after) {
				t.Fatal("foreign launcher replaced")
			}
			if got, err := os.Readlink(filepath.Join(binDir, "cxx")); err != nil || got != target {
				t.Fatalf("foreign cxx replaced: %s %v", got, err)
			}
		})
	}
}
