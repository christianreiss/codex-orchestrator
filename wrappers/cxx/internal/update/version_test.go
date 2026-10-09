package update

import "testing"

func TestCompareVersions(t *testing.T) {
	for _, tc := range []struct {
		target, current string
		cmp             int
		valid           bool
	}{
		{"0.9.37", "0.9.37", 0, true}, {"0.9.38", "0.9.37", 1, true},
		{"0.9.36", "0.9.37", -1, true}, {"v0.9.37", "0.9.37", 0, true},
		{"0.10.0", "0.9.37", 1, true}, {"0.9.38", "dev", 0, false},
		{"0.9.38-rc1", "0.9.37", 0, false}, {"0.9.9999999999999999999999", "0.9.37", 0, false},
	} {
		cmp, err := CompareVersions(tc.target, tc.current)
		if (err == nil) != tc.valid || (err == nil && cmp != tc.cmp) {
			t.Fatalf("%s/%s: cmp=%d err=%v", tc.target, tc.current, cmp, err)
		}
	}
}
