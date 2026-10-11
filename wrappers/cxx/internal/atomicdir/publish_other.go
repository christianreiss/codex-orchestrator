//go:build !linux && !darwin

package atomicdir

import "errors"

func exchange(stage, target string) error {
	return errors.New("atomic directory exchange unsupported on this platform")
}
func renameNew(stage, target string) error {
	return errors.New("atomic directory publication unsupported on this platform")
}
