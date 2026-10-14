// Package buildinfo exposes the running artifact's capabilities to HTTP clients.
package buildinfo

// Version is initialized once by main, before any clients or workers start.
// Signed config versions describe a target and must not substitute for this.
var Version = "dev"
