// Package operatorerror describes recoverable operator-facing failures without
// coupling host checks or maintenance services to a terminal renderer.
package operatorerror

import (
	"fmt"
	"strings"
)

type Step struct {
	Name string
	Err  error
}

func (e *Step) Error() string         { return e.Name + ": " + e.Err.Error() }
func (e *Step) Unwrap() error         { return e.Err }
func (e *Step) OperationStep() string { return e.Name }
func InStep(name string, err error) error {
	if err == nil {
		return nil
	}
	return &Step{Name: name, Err: err}
}

// HostnameMismatch keeps both identities available through wrapped errors. The
// advanced compatibility override remains explicit about the check it disables.
type HostnameMismatch struct{ Current, Expected, Override string }

func (e *HostnameMismatch) Error() string {
	return fmt.Sprintf("host name %q does not match this installation (%q). Check hostname and hostname -f; correct this machine's name or install the configuration registered for this host. Advanced: %s=1 disables host-name verification", e.Current, e.Expected, e.Override)
}
func (e *HostnameMismatch) Diagnostic() (string, []string) {
	expectedShort := strings.SplitN(e.Expected, ".", 2)[0]
	return "Host name does not match this installation", []string{
		fmt.Sprintf("This machine: %q", e.Current),
		fmt.Sprintf("Configured host: %q", e.Expected),
		"The operation stopped to avoid using another host's identity.",
		"Check: hostname; hostname -f",
		fmt.Sprintf("If this is %q, correct its host name (short name %q). Otherwise use an installer registered for this machine.", e.Expected, expectedShort),
		"After correcting the host identity, run: cxx cron run",
	}
}
