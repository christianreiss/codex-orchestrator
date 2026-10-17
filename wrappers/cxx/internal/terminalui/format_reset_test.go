package terminalui

import "testing"
import "time"

func TestResetInTextUsesDaysPastADay(t *testing.T) {
	cases := []struct {
		d    time.Duration
		want string
	}{
		{3*time.Hour + 5*time.Minute, "3h 5m"},
		{42 * time.Minute, "42m"},
		{24 * time.Hour, "1 day"},
		{36 * time.Hour, "2 days"},
		{6*24*time.Hour + 4*time.Hour, "6 days"},
	}
	for _, tc := range cases {
		if got := ResetInText(tc.d); got != tc.want {
			t.Fatalf("ResetInText(%s) = %q, want %q", tc.d, got, tc.want)
		}
	}
}
