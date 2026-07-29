package codex

import "testing"

// SemverGT is the sole gate on the self-update decision and on the "update
// available" banner, and it returns false whenever either side fails to parse.
// An unparseable target version therefore reads as "up to date" rather than as
// an update, so these cases pin exactly which strings parse.
func TestSemverGT(t *testing.T) {
	for _, tc := range []struct {
		name string
		a, b string
		want bool
	}{
		{name: "major greater", a: "2.0.0", b: "1.9.9", want: true},
		{name: "major lesser", a: "1.9.9", b: "2.0.0"},
		{name: "minor greater", a: "1.3.0", b: "1.2.9", want: true},
		{name: "minor lesser", a: "1.2.9", b: "1.3.0"},
		{name: "patch greater", a: "1.2.4", b: "1.2.3", want: true},
		{name: "patch lesser", a: "1.2.3", b: "1.2.4"},
		{name: "equal", a: "1.2.3", b: "1.2.3"},
		{name: "components compare numerically not lexically", a: "0.130.0", b: "0.99.0", want: true},

		// Build metadata is stripped before comparison, on either side.
		{name: "build metadata stripped on left", a: "1.2.4+build.7", b: "1.2.3", want: true},
		{name: "build metadata stripped on right", a: "1.2.3", b: "1.2.4+build.7"},
		{name: "build metadata alone is not a difference", a: "1.2.3+build.7", b: "1.2.3"},

		// The prerelease suffix is stripped from the patch component only, so a
		// release candidate compares equal to its own release.
		{name: "prerelease stripped from patch", a: "1.2.4-rc.1", b: "1.2.3", want: true},
		{name: "prerelease not greater than its release", a: "1.2.3-rc.1", b: "1.2.3"},
		{name: "release not greater than its prerelease", a: "1.2.3", b: "1.2.3-rc.1"},
		{name: "prerelease on minor is unparseable", a: "1.2-rc.1.3", b: "1.2.2"},

		// A leading "v" leaves the major component non-numeric, so a v-prefixed
		// string on either side suppresses the update.
		{name: "v-prefixed target does not update", a: "v1.2.4", b: "1.2.3"},
		{name: "v-prefixed installed does not update", a: "1.2.4", b: "v1.2.3"},
		{name: "v-prefixed on both sides", a: "v1.2.4", b: "v1.2.3"},

		// Anything that is not exactly three numeric components is unparseable,
		// and one bad side short-circuits the whole comparison.
		{name: "two components on left", a: "1.3", b: "1.2.3"},
		{name: "two components on right", a: "1.2.4", b: "1.2"},
		{name: "four components on left", a: "1.2.3.4", b: "1.2.3"},
		{name: "four components on right", a: "1.2.4", b: "1.2.3.4"},
		{name: "non-numeric component on left", a: "1.x.3", b: "1.2.3"},
		{name: "non-numeric component on right", a: "1.2.4", b: "1.x.3"},
		{name: "empty left", a: "", b: "1.2.3"},
		{name: "empty right", a: "1.2.4", b: ""},
		{name: "empty both", a: "", b: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := SemverGT(tc.a, tc.b); got != tc.want {
				t.Fatalf("SemverGT(%q, %q) = %v, want %v", tc.a, tc.b, got, tc.want)
			}
		})
	}
}
