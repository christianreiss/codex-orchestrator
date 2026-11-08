package clihelp

import (
	"bytes"
	"errors"
	"flag"
	"testing"
)

func TestParseSeparatesHelpFromFailureAndLiteralValues(t *testing.T) {
	for _, tc := range []struct {
		args       []string
		help, fail bool
	}{{[]string{"--help"}, true, false}, {[]string{"-h"}, true, false}, {[]string{"--unknown"}, false, true}, {[]string{"--text", "-h"}, false, false}} {
		var out, diagnostic bytes.Buffer
		flags := flag.NewFlagSet("safe command", flag.ContinueOnError)
		flags.SetOutput(&diagnostic)
		text := flags.String("text", "", "message")
		err := Parse(flags, tc.args, &out)
		if errors.Is(err, flag.ErrHelp) != tc.help || (err != nil && !errors.Is(err, flag.ErrHelp)) != tc.fail {
			t.Fatalf("%v: err=%v", tc.args, err)
		}
		if tc.help && (out.Len() == 0 || diagnostic.Len() != 0) {
			t.Fatalf("help streams: %q / %q", &out, &diagnostic)
		}
		if tc.fail && (out.Len() != 0 || diagnostic.Len() == 0) {
			t.Fatalf("error streams: %q / %q", &out, &diagnostic)
		}
		if !tc.help && !tc.fail && *text != "-h" {
			t.Fatal("literal value changed")
		}
	}
}
