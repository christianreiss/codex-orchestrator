package codexapp

import "testing"

func TestQuotaChoiceResetIsConsumed(t *testing.T) {
	f, positional, passthrough := parseFlags([]string{"run", "--quota-choice-reset"})
	if !f.quotaChoiceReset || len(positional) != 1 || positional[0] != "run" || len(passthrough) != 0 {
		t.Fatalf("flag leaked: %+v %v %v", f, positional, passthrough)
	}
}
