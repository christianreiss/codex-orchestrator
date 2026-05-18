# cdx Wrapper Interface (Source of Truth)

## Build + Publish
- `cdx` is a static Go binary built from `wrappers/cdx/cmd/cdx/main.go` and the `wrappers/cdx/internal/...` packages.
- Build locally with `cd wrappers && make cdx`; cross-compile every platform with `cd wrappers && make release`.
- CI workflow `.github/workflows/wrappers.yml` runs `go vet` + `go test` + the cross-compile matrix on every push.
- The published binary lives under `storage/wrapper/v2/bin/cdx/<os>-<arch>/v<version>/cdx`; the orchestrator serves it from `GET /wrapper/v2/bin/cdx/<os>-<arch>/v<version>/cdx`.

## Distribution surfaces

| Method | Path | Returns |
|---|---|---|
| GET | `/wrapper/v2/meta` | per-platform manifest + signing fingerprint |
| GET | `/wrapper/v2/config[?sig=1]` | signed per-host config JSON (or detached signature) |
| GET | `/wrapper/v2/download` | raw Go binary for the calling host's detected platform |
| GET | `/wrapper/download` | legacy shell-transition shim that writes v2 config, installs the binary, then execs it |
| GET | `/wrapper/v2/bin/cdx/<os>-<arch>/v<ver>/cdx` | the binary itself; ETag = SHA256 |

## Per-host config (typed, signed)

The orchestrator's `WrapperConfigService` produces a JSON blob
matching `wrappers/schemas/host-config-v1.json` and signs it with Ed25519. The
installer and the legacy transition shim write the result to
`~/.config/codex-orchestrator/cdx.json` (and its detached signature next door).
On startup the Go binary verifies the signature against the public key embedded
at build time, then loads the config:

```jsonc
{
  "schema_version": 1,
  "engine": "codex",
  "issued_at": "...",
  "orchestrator": {
    "base_url": "https://orch.example.com",
    "api_key": "sk-codex-...",
    "ca_bundle_path": null,
    "allow_insecure": false,
    "installation_id": "..."
  },
  "host": { "id": 42, "fqdn": "host01.example.com", "secure": true },
  "engine_options": {
    "silent": false,
    "model_override": "gpt-5.4",
    "reasoning_effort_override": "high",
    "admin_theme_hint": "auto"
  },
  "wrapper": {
    "version": "0.6.0",
    "track": "stable",
    "auto_update": true,
    "binary_url": "https://orch.example.com/wrapper/v2/bin/cdx/linux-amd64/v0.6.0/cdx",
    "binary_sha256": "..."
  }
}
```

## CLI surface

| Subcommand | Purpose |
|---|---|
| `run` (default) | One Codex session; the full startup sequence runs first |
| `status` | Local config summary + remote `/sync/status` ping |
| `doctor` | Self-diagnostic (config, CLI present, auth, reachability) |
| `lane <normal\|spark>` | Set this host's quota lane (`/host/lane`) |
| `profile <name>` | Forward `--profile <name>` to the upstream `codex` CLI |
| `exec -- <cmd...>` | Bypass the startup sequence and run a single Codex command |
| `--version` | Print version + commit + embedded pubkey status |
| `--update` | Self-update now (verifies SHA256 before swapping) |

## Startup sequence

1. `flock` on `$XDG_RUNTIME_DIR/cdx.lock` to enforce single-instance per host.
2. Load the signed config; refuse to proceed if the Ed25519 signature is invalid.
3. Auth sync (`POST /auth`) — best-effort; failure does not block.
4. Resource sync (`AGENTS.md`, `config.toml`) via `/agents/retrieve` and `/config/retrieve`.
5. `exec` the upstream `codex` CLI; forward stdio + signals.
6. Report `/usage` after exit (best-effort, non-blocking).

## Refusal modes

- Missing or tampered signature → `config signature invalid`; exit 2 without launching `codex`.
- `schema_version != 1` → `unsupported schema_version`; exit 2.
- `engine != "codex"` → `engine "..." not supported by this binary`; exit 2.
- Lock held by another PID → `another wrapper instance is running`; exit 1.

## Adding a new config field

1. Update `wrappers/schemas/host-config-v1.json` with the field.
2. Add it to `wrappers/cdx/internal/config/config.go` (and its `validate()` checks).
3. Have `App\Services\Wrapper\V2\ConfigBaker::bakeForHost` populate it.
4. Wire it through the binary wherever it changes behaviour.
5. Bump `wrappers/<engine>/cmd/<engine>/main.go`'s `Version` via `-ldflags`.
6. CI publishes the new binary; existing hosts pick it up via `--update`.
