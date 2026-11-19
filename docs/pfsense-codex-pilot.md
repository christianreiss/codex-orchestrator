# Codex on pfSense CE

CXX 0.9.188 adds an installer for one appliance image, pfSense CE 2.9.0-RELEASE on amd64 with `kern.osreldate=1600018`. The managed native client is the FreeBSD Codex port 0.167.0. The server, database, runner and release builder stay on the existing Orchestrator infrastructure.

## Installing the pilot

1. Register the firewall under its actual hostname, assign Codex alone and enable managed updates. Set its agent policy profile to allow `sandbox_mode = "danger-full-access"`. This grants the agent the filesystem and network rights of the invoking account. An installation as root grants access to the firewall configuration and credentials.
2. Run the normal host installer shown by the Orchestrator under that account. The GET launcher checks the edition, version, architecture, kernel ABI and engine assignment before it claims the token. The shell uses the appliance’s Python 3.11 when the unversioned Python command is absent.
3. Check `cxx doctor`, `cdx -W` and `cdx sync`. Start an interactive session with `cdx run`. For native CLI syntax, use `cxx native codex -- exec ...`. Full-access eligibility derives from the signed host posture. CXX rejects explicit restricted sandbox arguments to managed and emergency launches. A root account remains root throughout the process. The native FreeBSD client provides no kernel write sandbox. [Codex sandbox selection](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/sandboxing/src/manager.rs)

The binary bakery publishes five CXX artifacts as one version. Releases before 0.9.188 keep their four-platform publication contract. The installer verifies that the returned artifact URL targets the local platform and checks the digest before installation. CXX verifies the Ed25519 host config before using it. A post-install retry can reuse a healthy installation. FreeBSD uses the invoking account’s crontab, including for root.

The private engine prefix contains Codex, its code-mode companion, ripgrep and the two additional libraries. Exact package names, selected members and SHA-256 values are in `wrappers/cxx/internal/codex/pfsense.go`. The package hashes came from the signed FreeBSD catalogue. Installation downloads the pinned archives over HTTPS and stages the selected files under `~/.cxx/engines/codex`. The port uses the FreeBSD loader with a library search path scoped to the executable. The installer does not register packages or repositories with the appliance package manager. Package installation on pfSense has its own compatibility requirements. [FreeBSD Codex port](https://github.com/freebsd/freebsd-ports/tree/main/misc/codex) · [Netgate package documentation](https://docs.netgate.com/pfsense/en/latest/packages/index.html)

The validated port comes from a later FreeBSD package build (OSVERSION 1600031) than the appliance kernel. A new appliance ABI or client version needs another boot and tool-call test. A missing pinned upstream archive or checksum mismatch fails the installation or update. A host-specific client pin takes precedence and must name an available pilot version. Existing sessions retain their selected installation during staging.

## Compatibility evidence, 19 November 2026

| Platform | Artifact and runtime evidence | Service support |
|---|---|---|
| Linux amd64 | Release built and started natively. Linux is the host for the wrapper and API suites. | systemd host daemon, resident communicator and optional user worker are implemented. |
| Linux arm64 | Release built and returned its version under QEMU user-mode emulation. | Linux implementation. Hardware and systemd integration on ARM were outside this run. |
| macOS amd64 | Mach-O release built. The previously installed CXX 0.9.174 and the launchd environment were checked on Intel macOS 15.7.3. | launchd user worker. The resident host service requires Linux. |
| macOS arm64 | Mach-O release built. | launchd code path. No Apple Silicon guest was available for execution. |
| pfSense CE amd64 | The ordinary installer completed as root and under a separate lab user. Signed configuration, credential sync with a fixture, same-version reinstall, launcher diagnostics and a real native tool call passed. The installed binary matched the published FreeBSD artifact byte for byte. Both cron entries survived an appliance reboot, after which the root tool test passed again. | Personal cron and foreground sessions. The resident systemd service, unattended host daemon, persistent user service and managed RTK binary are outside the pilot. |
| TrueNAS CORE amd64 | The FreeBSD CXX binary ran on 13.3-RELEASE-p4. Native config and IPC tests passed. The installer rejected the appliance during preflight. The separate feasibility run exercised native Codex 0.125.0. | A managed CORE install needs its own client build and ABI policy. |

The pfSense acceptance run used an ephemeral signing key and a loopback control-plane and Responses fixture. The real CLI received an `exec_command` tool call, read a file in the guest, returned its contents in a second HTTP request and exited successfully. The fixture checked the file contents before emitting the final answer. On both FreeBSD guests the communicator suite also exercised concurrent request correlation, socket isolation and a real CXX MCP batch via a loopback WebSocket. The test harness supplied a cross-built binary with its fixture key because the appliances lack a Go compiler. The restricted launch returned an error before the tool ran. Live provider login, fleet account rotation and end-to-end portal delivery against a deployed API require separate acceptance. pfSense Plus and TrueNAS SCALE were outside the tested guest set.

Both lab guests were restored to their preceding powered-off state. All three virtual disks compared byte for byte with their cold snapshots. The inactive domain XML and previous current snapshot of each VM also matched.
