# TrueNAS SCALE and Community Edition (pilot)

**Status: pilot, untested on real hardware.** The host installer now recognises TrueNAS SCALE / Community Edition (Debian-based Linux, amd64) and stops early with a precise message where the platform's layout would make the install fail late. Nothing here has been run on a TrueNAS box. The preflight logic is exercised by tests that fake the TrueNAS marker file and use real read-only and noexec mounts in a throwaway user namespace on an ordinary Linux host, so the platform facts below come from the 2026-11-27 feasibility study (source reading), not from a TrueNAS system. TrueNAS CORE (FreeBSD) stays unsupported.

## Why SCALE needs its own preflight

| Fact | Consequence for the installer | Basis |
|---|---|---|
| `/usr` and `/opt` are read-only | The default `BIN_DIR=/usr/local/bin` cannot be written, with or without `sudo`. | Feasibility study 2026-11-27 |
| `/home` is mounted `noexec` (enforced since 24.10.1; the default admin user `truenas_admin` lives there) | Engine binaries under `~/.cxx/engines/<engine>` are derived from `$HOME` and cannot execute. | Feasibility study 2026-11-27 |
| `/root` and `/data` survive upgrades and `/root` allows exec | `/root` is the recommended install location. | Feasibility study 2026-11-27 |
| `/etc`, `/var` and `/var/lib` are recreated on every upgrade | `/etc/cron.d/cxx-managed`, user crontab spools and linger state are lost by an upgrade (a reboot keeps them). | Feasibility study 2026-11-27 |

A subtlety the preflight fixes for TrueNAS only: on an existing read-only `/usr/local/bin` the generic check's `mkdir -p` succeeds on the existing directory, so the generic preflight can pass and the install then fails later. The TrueNAS path decides by writing a script into the directory and executing it.

## What the preflight checks

Both the credential-free launcher (`GET /install/<token>`, which does not consume the token when it fails) and the installer run these checks before the header card.

1. **Detection.** Linux plus a readable `/data/manifest.json` that contains a `"version"` key. The TrueNAS middleware itself reads that file and key (`middlewared/utils/__init__.py`), so it is the primary marker. `/etc/version` is deliberately not used on SCALE, because whether it exists there is unverified.
2. **`BIN_DIR`.** The directory is created if needed, then a throwaway script is written into it and executed. A failed write reports that `BIN_DIR` is read-only or not writable; a successful write whose execution fails reports a `noexec` mount. If the plain user cannot write and `sudo -n` works, the same test runs through `sudo` (this changes nothing on a read-only filesystem, which `sudo` cannot write either).
3. **`$HOME/.cxx`.** The same write-and-execute test runs on the nearest existing ancestor of `$HOME/.cxx`, because the private engine prefix lives there. A noexec or unwritable home is reported with its own line.
4. **Upgrade notice.** When both checks pass, the installer prints a notice that cron and linger state is recreated empty by a TrueNAS upgrade. After an upgrade run `cxx cron install` again. The credential-free launcher does not print the notice; the installer does.

Each failure is one `ui_fail` line with the fix, and the run stops with the usual "the single-use installer was NOT consumed" message from the launcher. The probe file (`.cxx-probe.<pid>`) is removed afterwards.

The test hooks `TRUENAS_MANIFEST` (manifest path) and `BIN_DIR` can be set in the environment; nothing else in the installer changes for non-TrueNAS hosts.

## Recommended setup

Install as root with a per-user bin directory on a writable, executable filesystem:

```sh
sudo -i                    # becomes root with HOME=/root, which allows exec
export BIN_DIR=/root/.local/bin
# then run the installer command the Orchestrator shows for this host
```


If you install as an unprivileged user instead, both `BIN_DIR` and the home directory (or at least its `.cxx` location) must live on a dataset where Exec is enabled. The default `truenas_admin` home under `/home` does not qualify while it is mounted `noexec`.

TrueNAS documents a [Developer Mode](https://www.truenas.com/docs/scale/systemsettings/advanced/developermode) that relaxes parts of the read-only system. The installer neither uses nor detects it and this pilot does not rely on it; changes made that way are the operator's responsibility and the TrueNAS documentation describes its limits.

## Upgrade caveat for cron

A TrueNAS upgrade recreates `/etc`, `/var` and `/var/lib`, so `/etc/cron.d/cxx-managed`, user crontab spools and linger state are lost; a reboot alone keeps them. Run `cxx cron install` after every TrueNAS upgrade and confirm with `cxx doctor`. Integrating with the TrueNAS middleware's own cron facility (`midclt`) is a possible follow-up. It is out of scope here and was not evaluated on hardware.

## TrueNAS CORE is not supported

The preflight reports `TrueNAS CORE is not supported` and stops. CORE is FreeBSD-based. There is no upstream FreeBSD build of the Claude CLI to manage, and the CORE release train is closed (13.3-U1.2 is the final release; see the [CORE 13.3 release notes](https://www.truenas.com/docs/core/13.3/gettingstarted/corereleasenotes/)). The compatibility run in [pfSense CE pilot](pfsense-codex-pilot.md) found the FreeBSD `cxx` binary starts on CORE 13.3-RELEASE-p4, but a managed CORE install would need its own client build and ABI policy, which this project does not provide.

CORE detection is conservative and partly assumed, not verified on hardware: FreeBSD, not pfSense, and either `/etc/version` starting with `TrueNAS-` or `FreeNAS-`, or an executable `/usr/local/bin/midclt`. A pfSense appliance never takes this path, so its messages are unchanged.

## Verified and inferred

- Verified by tests on a generic Linux host: the generated shell parses; detection from a faked manifest; the write-and-execute test against real read-only and noexec tmpfs mounts and against a simulated noexec; the CORE message; unchanged behaviour for non-TrueNAS Linux and for pfSense.
- Taken from the 2026-11-27 feasibility study, not re-run: the read-only `/usr` and `/opt`, the noexec `/home`, which paths survive an upgrade, and the `/data/manifest.json` marker.
- Verified under both bash-as-`sh` and Debian's `dash` (container run of the generated launcher preflight with real read-only and noexec mounts); `shellcheck -s sh` is clean on the launcher and the installer.
- Open: any Linux host with a readable `/data/manifest.json` containing a `"version"` key takes the TrueNAS path, so a non-TrueNAS host with such a file gets the stricter checks; the exact CORE marker strings, whether `/etc/version` exists on SCALE, and the whole flow on a real installation.
