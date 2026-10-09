package update

import (
	"fmt"
	"strconv"
	"strings"
)

// CompareVersions returns -1, 0 or 1 for numeric wrapper release versions.
// Unknown/development builds fail closed rather than authorizing a downgrade.
func CompareVersions(target, current string) (int, error) {
	parse := func(value string) ([3]uint64, error) {
		var result [3]uint64
		parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(value), "v"), ".")
		if len(parts) != 3 {
			return result, fmt.Errorf("invalid wrapper version %q", value)
		}
		for i, part := range parts {
			if part == "" || strings.IndexFunc(part, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
				return result, fmt.Errorf("invalid wrapper version %q", value)
			}
			n, err := strconv.ParseUint(part, 10, 64)
			if err != nil {
				return result, fmt.Errorf("invalid wrapper version %q", value)
			}
			result[i] = n
		}
		return result, nil
	}
	a, err := parse(target)
	if err != nil {
		return 0, err
	}
	b, err := parse(current)
	if err != nil {
		return 0, err
	}
	for i := range a {
		if a[i] < b[i] {
			return -1, nil
		}
		if a[i] > b[i] {
			return 1, nil
		}
	}
	return 0, nil
}
