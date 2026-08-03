# Round-trip golden config fixtures

Three baked per-host wrapper configs, checked in as the exact bytes the
orchestrator signs and a host stores on disk, plus their detached Ed25519
signatures.

| File | Shape |
|------|-------|
| `host-codex.json` | secure host, `curl_insecure=0`, agent messaging enabled, both `documents` non-null, two skills, `model_override` + `reasoning_effort_override` set |
| `host-codex-insecure.json` | `secure=0` **and** `curl_insecure=1`: `host.secure:false`, `orchestrator.allow_insecure:true`, `agent_messaging.enabled:false`; `documents.client_config:null` and an empty `skills` array |
| `host-claude.json` | `engine: claude`, whose `engine_options` carries `claude_model_override` instead of `model_override`/`reasoning_effort_override` |
| `signing-seed.TEST-ONLY.txt` | base64 Ed25519 seed, **test material only** |

Both sides of the wire consume the same files:

- **Producer** — `api/test/unit/contract/wrapper-config-golden.test.ts` bakes each
  fixture and asserts `BakeResult.canonicalJson` is **byte-identical** to the
  `.json`, and that the primary signature is byte-identical to the `.json.sig`.
- **Consumer** — `wrappers/cxx/internal/config/golden_test.go` verifies the
  detached signature for real, loads each file through
  `config.LoadForEngine(path, pubkey, false, engine)` — never
  `allowUnsignedForTests` — and compares **every decoded field to a literal**
  written out in the test.

Any change to `api/src/services/wrapper-config.ts` that moves a baked byte
therefore shows up as a fixture diff instead of drifting silently.

## Regenerating — never hand-edit

```
cd api && UPDATE_GOLDEN=1 npx vitest run test/unit/contract/wrapper-config-golden.test.ts
```

That rewrites all six files from a live bake. Then run the Go half and read the
diff: `cd wrappers/cxx && go test ./internal/config/...`. The Go expectations
are literals on purpose, so a genuine baker change fails there until someone
decides the new value is correct. A fixture edited by hand instead of
regenerated has an invalid signature and fails immediately on the Go side.

The `.json` files are canonical single-line JSON because that is what is signed;
pretty-printing one breaks its signature. Read them with `python3 -m json.tool`.

## What is frozen, and why

Nothing is stripped before comparing, because nothing is left unfrozen.
Stripping `issued_at` would not have been enough anyway: `etag` is a SHA-256
over canonical JSON that itself contains `issued_at` and `config_version`.

| Input | Pinned to | Frozen by |
|-------|-----------|-----------|
| `issued_at` | `2026-01-15T00:00:00Z` | `vi.setSystemTime` |
| `expires_at` | `2026-02-14T00:00:00Z` | `issued_at` + `WRAPPER_CONFIG_TTL_SECONDS` |
| host row | per-fixture literal | in-test `Host` object |
| `wrapper.*` | version `2.4.0`, `linux/amd64`, fixed sha256 | fake `WrapperBinRegistry` |
| `orchestrator.installation_id` | `golden-installation-0001` | `WrapperConfigDeps.installationId` |
| `config_version` | fake `hosts.config_version` **+ 1** | fake DB (`bumpConfigVersion` returns `cur + 1`) |
| `documents` / `skills` | fixed rows in fixed order | fake DB |
| signature | the checked-in TEST-ONLY seed | Ed25519 is deterministic (RFC 8032) |

`activeSkills` selects without an `ORDER BY` and the payload preserves array
order, so in production the `skills` order — and therefore the `etag` — follows
whatever order the database returns. Here it is pinned only because the fake
DB's array order is fixed.

### The TTL is part of the fixtures' identity

`expires_at` is `issued_at + WRAPPER_CONFIG_TTL_SECONDS` (30 days, non-null on
every baked config). **Changing the TTL constant changes every fixture and every
signature.** If these files break right after someone touched
`WRAPPER_CONFIG_TTL_SECONDS`, that is an intended fixture update — regenerate
and update the Go literals. It is not an unexplained failure.

`issued_at` is deliberately in the past, so every fixture is expired by
construction and `config.LoadForEngine` **always** returns `*config.ExpiredError`
with a populated `Config`. `load.go` fills that field only after the detached
signature verified and `ValidateForEngine` passed, so the Go test asserts that
exact outcome rather than tolerating either branch. Picking a future date would
instead have made the Go test change behaviour on a calendar date.

### Signing keys

`signing-seed.TEST-ONLY.txt` is a throwaway Ed25519 seed generated for these
fixtures and used nowhere else. **Fixtures must never carry a production
signature**: the real per-installation key lives encrypted in
`wrapper_signing_keys` and is loaded only by `wrapper-signing-key.ts`.

The fixtures cover the **single-key** case, and `.json.sig` holds the primary
(oldest active key's) signature. Multi-sign needs no fixture of its own: extra
active keys sign the same canonical bytes and ride in `BakeResult.signatures`
beside the payload, so a rotation changes no signed byte. The producer test pins
exactly that — it re-bakes `host-codex` with two signers and asserts the golden
bytes and the primary `.sig` are unchanged.

## The Go/TS asymmetry is a stated contract

Go's `encoding/json` emits struct fields in declaration order while
`canonicalStringify` sorts keys, so the Go side cannot byte-compare a re-marshal
and does not try. It also decodes only what the wrapper uses: `documents`,
`skills` and `etag` have no field on `config.Config`.

`TestGoldenTopLevelKeySet` names those three in an allowlist and asserts the
fixture's top-level key set equals the json tags of `config.Config` plus that
allowlist. A new baked key nobody taught Go about fails there, and so does a new
`Config` field the fixtures do not carry.
