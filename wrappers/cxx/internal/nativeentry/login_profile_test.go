package nativeentry

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A login shell whose ~/.bash_profile never sources ~/.bashrc must still
// resolve native-bin first (feedback 95322f02).
func TestInstallReachesBashProfileThatSkipsBashrc(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(home, ".bash_profile")
	const originalProfile = "[ -x /usr/local/sbin/motd.sh ] && /usr/local/sbin/motd.sh\nprintf 'login profile diagnostic\\n' >&2\n"
	if err := os.WriteFile(profile, []byte(originalProfile), 0644); err != nil {
		t.Fatal(err)
	}
	opts := Options{Home: home, WrapperPath: "/usr/bin/cxx", Engines: []string{"codex"}}
	for i := 0; i < 2; i++ {
		if err := Install(opts); err != nil {
			t.Fatal(err)
		}
	}
	body, _ := os.ReadFile(profile)
	if !strings.HasPrefix(string(body), originalProfile) || strings.Count(string(body), blockStart) != 1 {
		t.Fatalf(".bash_profile = %q", body)
	}
	for _, shadow := range []string{".profile", ".bash_login"} {
		if _, err := os.Stat(filepath.Join(home, shadow)); !os.IsNotExist(err) {
			t.Fatalf("created %s next to .bash_profile: %v", shadow, err)
		}
	}
	if info, _ := os.Stat(profile); info.Mode().Perm() != 0644 {
		t.Fatalf(".bash_profile mode changed to %v", info.Mode().Perm())
	}
	status := Diagnose(home)
	if status.LoginProfile != profile || !status.LoginProfileActive {
		t.Fatalf("status = %+v", status)
	}
	if bash, err := exec.LookPath("bash"); err == nil {
		cmd := exec.Command(bash, "--login", "-c", `printf '%s' "$PATH"`)
		cmd.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
		// Login startup diagnostics must not become part of the measured PATH.
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("login shell: %v; stdout: %q; stderr: %q", err, out, stderr.String())
		}
		if !strings.Contains(stderr.String(), "login profile diagnostic\n") {
			t.Fatalf("login profile did not emit its diagnostic: %q", stderr.String())
		}
		if !strings.HasPrefix(string(out), BinDir(home)+":") {
			t.Fatalf("login shell PATH %q does not start with %s; stderr: %q", out, BinDir(home), stderr.String())
		}
	}
	if err := Remove(Options{Home: home}); err != nil {
		t.Fatal(err)
	}
	if body, _ := os.ReadFile(profile); string(body) != originalProfile {
		t.Fatalf("remove left %q", body)
	}
}

// ~/.profile is created only when no bash login file exists, and an existing
// ~/.profile that sources ~/.bashrc does not end up with a duplicated PATH.
func TestInstallLoginProfileFallbackAndNoPathDuplication(t *testing.T) {
	home := t.TempDir()
	if err := Install(Options{Home: home, WrapperPath: "/usr/bin/cxx", Engines: []string{"codex"}}); err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(home, ".profile")
	body, err := os.ReadFile(profile)
	if err != nil || strings.Count(string(body), blockStart) != 1 {
		t.Fatalf(".profile = %q, %v", body, err)
	}
	if _, err := os.Stat(filepath.Join(home, ".bash_profile")); !os.IsNotExist(err) {
		t.Fatal("must never create .bash_profile, it would shadow .profile")
	}

	// Debian-style profile sourcing .bashrc, plus a .bash_profile added later.
	if err := os.WriteFile(profile, append([]byte(". \"$HOME/.bashrc\"\n"), body...), 0644); err != nil {
		t.Fatal(err)
	}
	bashProfile := filepath.Join(home, ".bash_profile")
	if err := os.WriteFile(bashProfile, []byte(". \"$HOME/.profile\"\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := Install(Options{Home: home, WrapperPath: "/usr/bin/cxx", Engines: []string{"codex"}}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{profile, bashProfile, filepath.Join(home, ".bashrc")} {
		body, _ := os.ReadFile(path)
		if strings.Count(string(body), blockStart) != 1 {
			t.Fatalf("%s carries %d blocks: %q", path, strings.Count(string(body), blockStart), body)
		}
	}
	if bash, err := exec.LookPath("bash"); err == nil {
		cmd := exec.Command(bash, "--login", "-c", `printf '%s' "$PATH"`)
		cmd.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("login shell: %v; stdout: %q; stderr: %q", err, out, stderr.String())
		}
		if n := strings.Count(":"+string(out)+":", ":"+BinDir(home)+":"); n != 1 {
			t.Fatalf("login PATH %q has native-bin %d times; stderr: %q", out, n, stderr.String())
		}
	}
}

func TestDiagnoseFlagsLoginProfileWithoutBlock(t *testing.T) {
	home := t.TempDir()
	if err := Install(Options{Home: home, WrapperPath: "/usr/bin/cxx", Engines: []string{"codex"}}); err != nil {
		t.Fatal(err)
	}
	// A .bash_profile created after install shadows ~/.profile for bash.
	bashProfile := filepath.Join(home, ".bash_profile")
	if err := os.WriteFile(bashProfile, []byte("true\n"), 0644); err != nil {
		t.Fatal(err)
	}
	status := Diagnose(home)
	if status.LoginProfile != bashProfile || status.LoginProfileActive {
		t.Fatalf("status = %+v, want inactive %s", status, bashProfile)
	}
}
