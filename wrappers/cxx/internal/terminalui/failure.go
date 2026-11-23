package terminalui

import (
	"errors"
	"io"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/operatorerror"
)

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
	printFailure(w, caps, prefix, topic, err, make(map[string]struct{}))
}

func printFailure(w io.Writer, caps Caps, prefix, topic string, err error, seen map[string]struct{}) {
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
				printFailure(w, caps, prefix, topic, branch, seen)
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
	var details []string
	if summary, explanation := operatorerror.Describe(err, prefix); summary != "" {
		if step == nil {
			message = summary
		} else {
			details = append(details, summary)
		}
		details = append(details, explanation...)
	} else {
		details = []string{cause.Error(), retry}
	}
	key := message + "\n" + strings.Join(details, "\n")
	if _, duplicate := seen[key]; duplicate {
		return
	}
	seen[key] = struct{}{}
	PrintNotice(w, caps, Notice{Prefix: prefix, Topic: topic, Tone: ToneFail, Message: message, Details: details})
}
