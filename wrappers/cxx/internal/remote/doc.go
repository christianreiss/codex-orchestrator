// Package remote implements `cxx remote`: a process API on other machines,
// reached over SSH connections that OpenSSH — not this code — keeps alive.
//
// # Shape
//
// A `cxx remote` invocation is short-lived and owns no daemon. It runs the
// system ssh(1) with a private ControlMaster socket, so the TCP handshake and
// the authentication happen once per target per ControlPersist window and every
// later command is a channel on that existing connection. The remote end of
// each channel is this same binary, installed once under the remote user's
// home, invoked per operation and exiting with it.
//
// Jobs outlive their connection because their state is on disk, not in a
// process: one directory per job under <home>/jobs/<id>, holding the argv, an
// append-only log, the pid, and — only once the child is gone — its status. A
// cursor is therefore a byte offset into a real file, and a reconnect is a
// pread, never a re-run. A job started before a reboot is reported as lost
// rather than as running, because the boot id recorded at start no longer
// matches.
//
// # Trust boundary
//
// Same uid on the calling host, and nothing more. The agent that invokes this
// command already has ssh(1) on its PATH and the user's keys in ~/.ssh; this
// package adds no reach it did not have. What it adds is structure — argv
// arrays instead of shell strings, jobs that can be re-addressed, and a record
// of what ran. Anything that reads like confinement here is a misreading:
// `cxx remote exec` is unsandboxed code execution on another machine, and a
// locally sandboxed caller gains exactly that by using it.
package remote
