// Package clihelp keeps local command discovery free of operational effects.
package clihelp

import (
	"errors"
	"flag"
	"fmt"
	"io"
)

// Requested is for wrapper-owned argument lists, never native argv or prompt text.
func Requested(args []string) bool {
	for _, arg := range args {
		if arg == "--" {
			break
		}
		if arg == "--help" || arg == "-h" {
			return true
		}
	}
	return false
}

// Parse writes explicit help to stdout and retains errors on the flag set's
// diagnostic stream. Callers must treat flag.ErrHelp as a successful return.
func Parse(flags *flag.FlagSet, args []string, stdout io.Writer) error {
	diagnostic := flags.Output()
	flags.SetOutput(io.Discard)
	err := flags.Parse(args)
	if errors.Is(err, flag.ErrHelp) {
		flags.SetOutput(stdout)
		flags.Usage()
	} else if err != nil {
		flags.SetOutput(diagnostic)
		fmt.Fprintln(diagnostic, err)
		flags.Usage()
	}
	flags.SetOutput(diagnostic)
	return err
}
