package codex

import (
	"strconv"
	"strings"
)

// SemverGT returns true when a > b using simple X.Y.Z numeric comparison.
// Returns false when either string cannot be parsed as semver.
func SemverGT(a, b string) bool {
	return semverGT(a, b)
}

func semverGT(a, b string) bool {
	parse := func(s string) (maj, min, pat int, ok bool) {
		p := strings.SplitN(strings.SplitN(s, "+", 2)[0], ".", 3)
		if len(p) != 3 {
			return
		}
		var err error
		if maj, err = strconv.Atoi(p[0]); err != nil {
			return
		}
		if min, err = strconv.Atoi(p[1]); err != nil {
			return
		}
		if pat, err = strconv.Atoi(strings.SplitN(p[2], "-", 2)[0]); err != nil {
			return
		}
		ok = true
		return
	}
	aMaj, aMin, aPat, aOk := parse(a)
	bMaj, bMin, bPat, bOk := parse(b)
	if !aOk || !bOk {
		return false
	}
	if aMaj != bMaj {
		return aMaj > bMaj
	}
	if aMin != bMin {
		return aMin > bMin
	}
	return aPat > bPat
}
