//go:build !windows

package lifecycle

import "os"

// restrictConfigMode removes group and world access from an existing
// config.toml that no sync rewrites (an unchanged digest is never rewritten,
// so a file written 0644 by an older wrapper would otherwise stay readable).
// A missing file or a symlink is left alone: a symlinked config belongs to
// whoever placed it, and the next content write replaces the link anyway.
func restrictConfigMode(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 == 0 {
		return nil
	}
	return os.Chmod(path, info.Mode().Perm()&^0o077)
}
