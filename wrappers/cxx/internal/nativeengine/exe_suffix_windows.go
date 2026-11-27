//go:build windows

package nativeengine

// exeSuffix is appended to the native executable name under <home>/bin; the
// installers stage grok.exe and kimi.exe there on Windows.
const exeSuffix = ".exe"
