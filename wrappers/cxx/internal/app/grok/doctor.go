package grok

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
	"github.com/pelletier/go-toml"
)

// doctorInput is what status() already measured; the doctor adds local checks
// and never reads or changes credentials.
type doctorInput struct {
	Config        *config.Config
	Home          string
	CLIPath       string
	EngineVersion string
	VersionErr    error
	Auth          *startupAuth
	AuthErr       error
	Latency       time.Duration
}

func doctorReport(in doctorInput) terminalui.DoctorReport {
	report := terminalui.DoctorReport{Engine: "cgx", When: time.Now()}
	hints := []string{}
	row := func(label string, tone terminalui.Tone, value string) {
		report.Rows = append(report.Rows, terminalui.DoctorRow{Label: label, Tone: tone, Value: value})
	}

	if source := in.Config.SourcePath(); source != "" {
		row("Paths", terminalui.ToneOK, fmt.Sprintf("home=%s config=%s", in.Home, source))
	} else {
		row("Paths", terminalui.ToneOK, "home="+in.Home)
	}

	switch {
	case in.VersionErr != nil || in.EngineVersion == "":
		row("CLI", terminalui.ToneFail, "Grok CLI missing or unusable")
		hints = append(hints, "Run `cgx update` to install the fleet's Grok CLI.")
	default:
		tone, value := terminalui.ToneOK, fmt.Sprintf("grok %s (%s)", in.EngineVersion, in.CLIPath)
		if in.Auth != nil && in.Auth.Versions != nil {
			target := stringValue(in.Auth.Versions.ClientVersionOverride)
			if target == "" {
				target = stringValue(in.Auth.Versions.ClientVersion)
			}
			if target != "" && target != "latest" && target != in.EngineVersion {
				tone, value = terminalui.ToneWarn, value+"; fleet target "+target
				hints = append(hints, "Run `cgx update` to converge on the fleet's Grok version.")
			}
		}
		row("CLI", tone, value)
	}

	configPath := filepath.Join(in.Home, "config.toml")
	if raw, err := os.ReadFile(configPath); errors.Is(err, os.ErrNotExist) {
		row("Config", terminalui.ToneWarn, "config.toml missing (run `cgx sync`)")
	} else if err != nil {
		row("Config", terminalui.ToneFail, err.Error())
	} else if _, err := toml.LoadBytes(raw); err != nil {
		row("Config", terminalui.ToneFail, "config.toml does not parse: "+err.Error())
	} else {
		row("Config", terminalui.ToneOK, fmt.Sprintf("config.toml parses; %d fleet-owned keys", ownedKeyCount()))
	}

	row(instructionsCheck(in.Home))
	row(skillsCheck())

	authTone, authValue := terminalui.ToneOK, "subscription account available"
	refusal := launchRefusal(in.Config, in.AuthErr)
	switch {
	case refusal != nil:
		// An administrator decision, not a login problem: `cgx login` cannot fix it.
		authTone, authValue = terminalui.ToneFail, refusal.Error()
		if refusal.Error() == config.FleetDisabledMessage(config.EngineGrok) {
			row("Engine", terminalui.ToneFail, "suspended (fleet)")
			hints = append(hints, refusal.Error()+" Launches and maintenance are paused until it is switched back on; nothing on this host needs repair.")
		}
	case in.AuthErr != nil:
		authTone, authValue = terminalui.ToneFail, in.AuthErr.Error()
		hints = append(hints, "Run `cgx login` if the subscription login must be renewed.")
	case in.Auth == nil || in.Auth.VerificationState != "verified":
		authTone, authValue = terminalui.ToneFail, "no verified Grok login"
	}
	row("Auth", authTone, authValue)

	latencyTone := terminalui.ToneOK
	switch {
	case in.Latency > 5*time.Second:
		latencyTone = terminalui.ToneFail
	case in.Latency > 2*time.Second:
		latencyTone = terminalui.ToneWarn
	}
	row("Latency", latencyTone, in.Latency.Truncate(time.Millisecond).String())

	row(diskCheck(in.Home))
	if state, err := native.StateDir(); err == nil {
		row("Leader logs", terminalui.ToneOK, filepath.Join(state, "leader-logs"))
	}
	row(cronCheck())
	session := "local"
	if os.Getenv("SSH_TTY") != "" || os.Getenv("SSH_CONNECTION") != "" {
		session = "ssh"
	}
	row("SSH env", terminalui.ToneOK, "session="+session+"; TERM="+os.Getenv("TERM"))

	failures, warned := 0, false
	for _, r := range report.Rows {
		switch r.Tone {
		case terminalui.ToneFail:
			failures++
		case terminalui.ToneWarn:
			warned = true
		}
	}
	switch {
	case failures > 0:
		report.Result = terminalui.DoctorRow{Label: "Result", Tone: terminalui.ToneFail, Value: fmt.Sprintf("%d check(s) failed", failures)}
	case warned:
		report.Result = terminalui.DoctorRow{Label: "Result", Tone: terminalui.ToneWarn, Value: "checks passed with warnings"}
	default:
		report.Result = terminalui.DoctorRow{Label: "Result", Tone: terminalui.ToneOK, Value: "all checks passed"}
	}
	report.Hints = hints
	return report
}

func ownedKeyCount() int {
	state, err := native.StateDir()
	if err != nil {
		return 0
	}
	raw, err := os.ReadFile(filepath.Join(state, "managed-keys.json"))
	if err != nil {
		return 0
	}
	var owned struct {
		Paths map[string]string `json:"paths"`
	}
	if json.Unmarshal(raw, &owned) != nil {
		return 0
	}
	return len(owned.Paths)
}

func instructionsCheck(home string) (string, terminalui.Tone, string) {
	body, err := os.ReadFile(filepath.Join(home, "AGENTS.md"))
	if err != nil {
		return "Instructions", terminalui.ToneWarn, "AGENTS.md missing (run `cgx sync`)"
	}
	state, err := native.StateDir()
	if err != nil {
		return "Instructions", terminalui.ToneWarn, err.Error()
	}
	recorded, err := os.ReadFile(filepath.Join(state, "managed-agents.sha256"))
	if err != nil {
		return "Instructions", terminalui.ToneWarn, "AGENTS.md present but not fleet-managed"
	}
	sum := sha256.Sum256(body)
	if strings.TrimSpace(string(recorded)) != hex.EncodeToString(sum[:]) {
		return "Instructions", terminalui.ToneWarn, "AGENTS.md changed locally; the next sync restores it"
	}
	return "Instructions", terminalui.ToneOK, "AGENTS.md matches the fleet document"
}

func skillsCheck() (string, terminalui.Tone, string) {
	store, err := native.Skills()
	if err != nil {
		return "Skills", terminalui.ToneWarn, err.Error()
	}
	owned, intact := store.Count(), len(store.Digests())
	switch {
	case owned == 0:
		return "Skills", terminalui.ToneWarn, "no fleet skills installed in " + store.Root + " (run `cgx sync`)"
	case intact < owned:
		return "Skills", terminalui.ToneWarn, fmt.Sprintf("%d of %d fleet skills drifted; the next sync restores them", owned-intact, owned)
	}
	return "Skills", terminalui.ToneOK, fmt.Sprintf("%d fleet skills in %s", owned, store.Root)
}

func diskCheck(home string) (string, terminalui.Tone, string) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(home, &stat); err != nil {
		return "Disk", terminalui.ToneWarn, err.Error()
	}
	freeMB := stat.Bavail * uint64(stat.Bsize) / (1024 * 1024)
	tone := terminalui.ToneOK
	switch {
	case freeMB < 500:
		tone = terminalui.ToneFail
	case freeMB < 1000:
		tone = terminalui.ToneWarn
	}
	return "Disk", tone, fmt.Sprintf("%dMB free", freeMB)
}

func cronCheck() (string, terminalui.Tone, string) {
	if _, err := os.Stat("/etc/cron.d/cxx-managed"); err == nil {
		return "Cron", terminalui.ToneOK, "installed (system /etc/cron.d/cxx-managed)"
	}
	out, err := exec.Command("crontab", "-l").Output()
	if err == nil && strings.Contains(string(out), "# cxx-managed-cron") {
		return "Cron", terminalui.ToneOK, "installed (user crontab)"
	}
	return "Cron", terminalui.ToneWarn, "not installed (run `cgx cron install`)"
}
