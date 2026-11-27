# Platform feasibility: Windows, Claude on pfSense, TrueNAS (2026-11-27)

Read-only studies of cxx 0.9.216 (commit `1eb31da`). Nothing was run on a Windows,
pfSense or TrueNAS machine; verdicts come from the code, upstream release metadata
and cross-compiles. "Inferred" marks anything not observed.

## Summary

| Target | Verdict | Effort | State after this change |
|---|---|---|---|
| Codex on Windows (amd64/arm64) | Feasible with caveats | L | Installer mapping and compile foundation only |
| Claude on Windows | Feasible with caveats (pilot M–L) | L | Installer mapping and compile foundation only |
| Grok on Windows | Not blocked upstream; cxx port needed | L | Installer mapping and compile foundation only |
| Kimi on Windows | Not blocked upstream; cxx port needed | L | Installer mapping and compile foundation only |
| WSL2 (all engines) | Probably works as `linux-amd64`; untested | S | Not changed |
| Claude on pfSense CE | Feasible only through the FreeBSD `misc/claude-code` port on Node | L | Not implemented, see below |
| Claude on TrueNAS SCALE / CE | Feasible with a stricter preflight | M | Preflight and docs |
| Claude on TrueNAS CORE | Blocked upstream | n/a | Clear "unsupported" message |

Windows is **not published**: `SUPPORTED_WRAPPER_PLATFORMS`, `wrappers/Makefile`
`PLATFORMS` and the host installer are unchanged.

## Windows (all engines)

All four engines hit the same cxx blockers; the engine-specific parts are small.

**Upstream ships Windows builds for every engine.**
- Codex `rust-v0.172.0`: `codex-package-{x86_64,aarch64}-pc-windows-msvc.tar.gz`; the sandbox helpers exist only inside the package (`bin/codex.exe`).
- Claude: npm `@anthropic-ai/claude-code-win32-{x64,arm64}` (single `package/claude.exe`, sha512 integrity); Git Bash is optional.
- Grok: npm `@xai-official/grok-win32-{x64,arm64}` (`package/bin/grok.exe.br`); xAI's `install.ps1` also bundles MinGit.
- Kimi: Moonshot manifest lists `win32-x64` and `win32-arm64` (`kimi-code-win32-<arch>.exe`, sha256); Kimi needs Git Bash on Windows.

**cxx does not compile for Windows.** `GOOS=windows` reports ~193–197 type errors in
~35 files across 25–26 of 90 packages (`flock` ~122, `Stat_t` ~30, `O_NOFOLLOW` 14,
`SysProcAttr` ~8, `fcntl` 8, `unix.Access` 6, `Kill` 4, missing `execNative`). Four leaf
packages (`ipc`, `layout`, `sessionnotice`, `accountgate`) block 61 dependents.

**Runtime blockers that compile but fail** (not addressed yet):
- Every `clx` launch passes lease handles through `ExtraFiles` (`claude/auth_child.go`), which Windows rejects.
- Exec-bit checks (`nativeentry.go`, `nativeengine/store.go`) never find a `.exe`.
- `syscall.Exec` always fails, so self-update/relaunch needs spawn-and-exit; a running `cxx.exe` cannot be replaced in place.
- `0600`/`0700` and uid ownership checks protect credential files and the access-only token homes (Grok, Kimi). They must become real ACL checks; stubs fail closed.
- Persona aliases (`cdx`, `clx`, ...) are symlinks (admin or Developer Mode); shims are `#!/bin/sh`; no cron/systemd/launchd equivalent (Task Scheduler).
- Kimi hooks run through `cmd.exe`; our POSIX single-quote quoting would silently drop peer and portal messages.
- Claude receiver hooks use POSIX quoting too; exec form is needed.
- Installer is `/bin/sh`; a PowerShell installer and a `windows-*` branch of the signed config are required.

**Proposed pilot** (next step, needs a Windows machine): one engine (Claude or Codex),
windows/amd64, interactive launch, communicator/RTK/cron/reboot off (the pfSense pattern),
real file locks and ACL checks, PowerShell installer.

**Cannot be verified without Windows:** ACL semantics, replacing a running `.exe`,
hook shell selection, Defender/SmartScreen, terminal UI, arm64, WSL idle shutdown.

**WSL2** reports Linux and should work with the Linux build. Untested gaps: cron and
the resident service need systemd (`systemd=true` in `wsl.conf`); an idle WSL VM
shuts down and stops receivers; `agent_reboot` is meaningless there; repos under `/mnt/c`
change locking and modes. No WSL detection exists in the repo.

## Claude on pfSense CE

Anthropic ships no FreeBSD build (issue closed "not planned", 2026-08-19). The only
route is FreeBSD's `misc/claude-code` port: JS extracted from the Linux Bun binary,
a Bun polyfill, and a third-party GPLv3 shim, running on Node 24. About 26 packages,
51 MiB, installed into `~/.cxx/engines/claude` like the Codex pilot. Linux emulation
is rejected by Netgate and reportedly hangs on Claude Code 2.1.282+.

**Not implemented.** It needs an operator decision: the port is a third-party
extraction of Anthropic's proprietary client with a user-agent patch that the
prebuilt package cannot turn off, run on fleet subscription accounts. It also
trails npm by 5+ releases, was built for OSVERSION 1600031 (kernel 1600018), and
needs a real pfSense guest for verification.

**Existing defect found:** two of four packages pinned by the Codex pfSense pilot
(`codex-0.167.0~2$ibesqrb8.pkg`, `dbus-1.16.4,1~2$p7kxnngj.pkg`) return 404, because
FreeBSD:16 has only a rolling `latest` package set. New pilot installs and
same-version repairs fail; installed hosts keep working. Reported as feedback
`ae727db4-6488-48a4-ac80-69d4a832037f`. Hosting the pinned packages in the bakery
would fix both.

## TrueNAS

**CORE (FreeBSD 13.3): blocked.** No FreeBSD Claude package; the port has no
FreeBSD:13 packages; the release train ended at 13.3-U1.2. Run Claude in a Linux VM
or move the box to CE.

**SCALE / Community Edition: feasible with caveats.** cxx `linux-amd64` should run,
but the installer would fail late:
- `/usr` and `/opt` are read-only, so the default `BIN_DIR=/usr/local/bin` fails.
- `/home` is `noexec`, so `~/.cxx/engines/claude` cannot execute for `truenas_admin`. `/root` and `/data` survive upgrades and `/root` can execute.
- `etc`, `var` and `var/lib` are recreated on upgrade, which removes `/etc/cron.d/cxx-managed`, user crontabs and linger state.
- Inferred: `ensure_bin_root` can pass on a read-only existing directory via the `sudo` branch.

Implemented: SCALE detection, early preflight failures with fix hints, an upgrade
caveat notice, and `docs/truenas-scale.md`. Not implemented: middleware (`midclt
cronjob`) persistence across upgrades; needs a real SCALE box.

## Open items

1. Windows pilot on a real machine (engine choice, ACLs, locks, PowerShell installer).
2. Decision on Claude for pfSense (terms and account risk, version lag).
3. Mirror the pfSense pinned packages in the bakery (fixes the Codex pilot 404s).
4. SCALE: `midclt` cron persistence and a hardware test.
5. WSL2: documentation and a doctor check.
