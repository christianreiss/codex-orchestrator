//go:build windows

package codex

// exeSuffix is appended to native executable file names this package stages;
// CreateProcess appends .exe to an extensionless path, so a bare name never runs.
const exeSuffix = ".exe"
