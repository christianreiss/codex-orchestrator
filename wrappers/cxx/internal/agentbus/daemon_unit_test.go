package agentbus

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestHostDaemonUnitAcceptedBySystemd(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux service")
	}
	verify, err := exec.LookPath("systemd-analyze")
	if err != nil {
		t.Skip("systemd-analyze unavailable")
	}
	for _, home := range []string{"/root", "/tmp/service home % test"} {
		t.Run(home, func(t *testing.T) {
			unit := filepath.Join(t.TempDir(), "cxx-daemon-probe.service")
			body := hostDaemonUnit("root", home, "", "/bin/true")
			if err := os.WriteFile(unit, []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
			if output, err := exec.Command(verify, "verify", unit).CombinedOutput(); err != nil {
				t.Fatalf("systemd rejected daemon unit: %v\n%s", err, output)
			}
		})
	}
}
