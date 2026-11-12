package terminalui

import (
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/operatorerror"
	"io"
	"strings"
)

type operatorDiagnostic interface{ Diagnostic() (string, []string) }
type operationStep interface {
	OperationStep() string
	Unwrap() error
}

// Failure uses wrapping detail lines, never the bounded single-line renderer:
// paths, host identities and repair instructions must survive narrow terminals
// and redirected installer logs. Joined failures remain independent notices.
func Failure(w io.Writer, prefix, topic string, err error) {
	PrintFailure(w, DetectCapsFor(w, ""), prefix, topic, err)
}
func PrintFailure(w io.Writer, caps Caps, prefix, topic string, err error) {
	if err == nil {
		return
	}
	// Look through ordinary wrappers before selecting a diagnostic: errors.As
	// alone would choose the first joined cause and silently hide the others.
	stepName := ""
	for current := err; current != nil; current = errors.Unwrap(current) {
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			for _, branch := range joined.Unwrap() {
				if stepName != "" {
					branch = operatorerror.InStep(stepName, branch)
				}
				PrintFailure(w, caps, prefix, topic, branch)
			}
			return
		}
		if step, ok := current.(operationStep); ok && stepName == "" {
			stepName = step.OperationStep()
		}
	}
	message := "Operation could not finish"
	retry := "After fixing the reported cause, retry this command."
	switch topic {
	case "cron", "cron run":
		message = "Maintenance could not finish"
		retry = "After fixing the reported cause, retry: cxx cron run"
	case "cron install":
		message = "Could not install the maintenance schedule"
		retry = "After fixing the reported cause, retry: cxx cron install"
	case "cron remove":
		message = "Could not remove the maintenance schedule"
		retry = "After fixing the reported cause, retry: cxx cron remove"
	}
	cause := err
	var step operationStep
	if errors.As(err, &step) {
		message = step.OperationStep() + " failed"
		cause = step.Unwrap()
	}
	var diagnostic operatorDiagnostic
	var details []string
	if errors.As(err, &diagnostic) {
		summary, explanation := diagnostic.Diagnostic()
		if step == nil {
			message = summary
		} else {
			details = append(details, summary)
		}
		details = append(details, explanation...)
	} else {
		details = strings.Split(cause.Error(), "\n")
		details = append(details, retry)
	}
	PrintNotice(w, caps, Notice{Prefix: prefix, Topic: topic, Tone: ToneFail, Message: message, Details: details})
}
