// Package posix names the handful of POSIX file primitives the wrapper uses
// for advisory locks, symlink-safe opens and owner checks. On Unix every
// identifier is the syscall package's own value, so call sites behave exactly
// as if they named syscall directly. On Windows the same names compile to a
// LockFileEx-based lock, an open flag the runtime rejects, and a stat type no
// os.FileInfo ever carries, so owner checks fail closed.
package posix
