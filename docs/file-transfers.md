# Binary agent file transfers (cxx 0.9.93)

Agent A uploads to the orchestrator's existing TTL pool, sends the transfer ID
through agent messaging, and Agent B downloads to its chosen local path. No
recipient is registered and no notification is sent automatically. Any
host authenticated for an enabled engine and managed transfer module may download
by ID. Only the uploading host may continue or complete its binary upload.

```sh
cxx transfer put ./artifact.tar --ttl-seconds 3600 --json
cxx transfer get <id> --output ./artifact.tar --json
# After an interrupted command, repeat it with --resume.
```

`cdx transfer`, `clx transfer`, `cgx transfer` select their respective engines.
`cxx transfer` uses `CXX_AGENT_PORTAL_ENGINE` inside a managed agent, otherwise
Codex; `--engine codex|claude|grok` overrides it. All commands load the signed
host config and retain its TLS/CA and host authentication policy. Transfer bytes
stream through the communicator over independent HTTPS streams, never control
frames or model context. API, wrapper and the running communicator must support
this version; upgrade the communicator owner too when rolling out the wrapper.

`--json` writes metadata (ID, size, SHA-256, status, expiry, TTL clamp) to stdout;
progress and errors go to stderr. A missing CLI TTL uses 3600 seconds; the HTTP
creation request always supplies it explicitly. The server reports the granted
expiry after clamping. A two-minute request inactivity timer cancels stalls;
there is no total file-duration timeout.

Upload state lives next to the source in `<source>.cxx-upload.json` (mode 0600),
created before the first request. It contains the stable UUID, source fingerprint,
engine, path and server URL, without credentials. `--resume` rechecks the source
hash, repeats idempotent creation, and continues at the server's confirmed offset.
The journal is removed on success. A changed source requires a fresh upload;
remove the old journal after deciding to abandon it, and delete the old server
transfer through `transfer_delete` or let its TTL expire.

Any upload failure after the journal exists, including the communicator's
`Local communicator disconnected; request outcome unknown` (HTTP 409), may leave
an `uploading` server record. The error then names the transfer ID, the journal,
the exact `cxx transfer put FILE --resume --engine ENGINE` command, and the
abandon steps (`transfer_delete ID`, then remove the journal). With `--json`,
stdout also receives one object `{error, id, outcome: "unknown", journal,
resume_command, abandon}` and the exit status stays 1. A plain repeat of the same
`put` is refused while the journal exists, so retries cannot allocate a second
upload; an abandoned record keeps its quota reservation until deleted or until
its TTL expires.

Downloads use `<output>.cxx-part` and an adjacent `.json` journal. Resume uses
HTTP Range and verifies the complete SHA-256, including the existing prefix.
Chunked responses with no declared content length are accepted; the actual byte
count must still match metadata, and known mismatched lengths are refused before
reading. Size errors report expected and received counts. Oversized, incomplete
or hash-mismatched responses never publish the destination.
Only a verified file is published at the chosen path. The default publication
atomically refuses an existing target; `--overwrite` permits atomic replacement.
Keep journals and partial files to resume; delete both to abandon a download.
A hash mismatch leaves the partial file unpublished: discard it and restart.

## Troubleshooting: HTTP 413 from an old communicator owner

Transfer requests go through the running local communicator owner, which may be
older than the `cxx` that issues them: a resident service runs its own root-owned
copy (`/usr/local/lib/cxx-daemon/cxx`) that `cxx update` does not replace until
the update handoff is installed, and an on-demand owner keeps running its old
image while leases or native agents keep it busy. An owner older than 0.9.93
(commit cdc9e6b9) buffers every request body and refuses anything over 8 MiB
with a plain-text HTTP 413, so every 16 MiB upload chunk fails. Before the fix
the CLI printed only `transfer HTTP 413: ` and left an `uploading` record at
zero bytes; non-JSON error bodies are now shown, bounded to one 200-character
line (`transfer HTTP 413: communicator request too large`).

From cxx 0.9.107, `cxx transfer put` reads the owner's local `/_comm/status` (no server
request, never starting an owner) before hashing the file. When the owner
reports a release older than 0.9.93 and the file exceeds 8 MiB, it exits 1
before any journal or server record exists, naming the owner's version and PID.
With `--json`, stdout gets `{error, outcome: "not_started", owner_version,
owner_pid, owner_mode, required_version, remedy}`. The remedy depends on the
owner's `mode`:

- `resident`: refresh the service copy from the installed `cxx` and restart it
  with `sudo cxx daemon install`. (`cxx communicator stop` only runs
  `systemctl stop cxx-daemon.service` and does not refresh the copy.)
- `on_demand`: `kill <pid>` (SIGTERM closes the owner and cuts its in-flight
  requests); the next managed call starts a new owner from the installed `cxx`.

Smaller files, unversioned (`dev`) owners and owners whose status cannot be read
(none running, direct HTTPS) proceed unchanged. Downloads are not checked: they
carry no request body, so the 8 MiB refusal cannot occur, and an old owner
retries oversized relayed reads as a streamed HTTPS request (not verified
end-to-end against a 0.9.83 owner). `cxx communicator doctor` reports the same
stale owner as `stale_owner`.

## HTTP interface

All routes require host authentication, host/IP and insecure-window policy,
explicit `?engine=codex|claude|grok`, engine assignment/master switch, managed
configuration/MCP enablement and `transfers_module_enabled`.

| Method and path | Request / response |
| --- | --- |
| `POST /host/transfers` | JSON `{id, name, size_bytes, content_sha256, ttl_seconds, username?, worktree_path?, description?, mime_type?}`. `id` is a client-generated UUID v4, reused on retries. Returns `{transfer, chunk_bytes}`. The same host/ID/name/size/hash/TTL returns the existing transfer without extending its expiry; a changed identity conflicts. |
| `GET /host/transfers/:id` | `{transfer, chunk_bytes}`; `transfer.size_bytes` is the durable upload offset, `expected_size_bytes` the reserved complete size (null for legacy uploads). |
| `PUT /host/transfers/:id/content?offset=N` | `application/octet-stream`, explicit `Content-Length`, 1–16 MiB per request. Returns `{transfer}` only after file sync and metadata commit. This is a request bound, not a file bound. |
| `POST /host/transfers/:id/complete` | Verifies declared size and SHA-256 before making the file live; repeatable after a lost response. Empty uploads complete directly. Returns `{transfer}`. |
| `GET /host/transfers/:id/content` | Raw bytes with `Content-Length`, SHA-256 `ETag`, `Accept-Ranges: bytes`, and `Cache-Control: no-store`. Optional single open-ended `Range: bytes=N-` returns 206 and `Content-Range`; invalid ranges return 416. |

JSON responses use the standard API envelope. Binary bodies are never enveloped.
No separate transfer credential or schema is introduced for each engine.
Legacy MCP `transfer_put/get` remain compatible with 4 MiB base64 messages and
share the same pool; legacy append cannot alter a binary upload.

## Storage, limits and failure handling

`max_file_bytes` and `quota_bytes` now default to **0 = unlimited**; explicit
existing settings remain unchanged. Optional limits accept nonnegative exact
integers, with no 64 MiB product ceiling. Offsets/sizes use JavaScript's exact
integer range (through 2^53−1 bytes); filesystem and available disk limits apply.
TTLs retain the existing 60-second floor and seven-day maximum.

Agents can read the configured caps and the remaining pool before uploading:
the MCP `transfer_list` reply carries a `limits` object (`null` means no cap).
Binary creation already refuses an over-cap or over-quota declared size before
any byte moves, and MCP `transfer_put` does the same when the first call passes
`expected_size_bytes`.

Binary creation reserves the entire declared size against an enabled quota.
`used_bytes` includes reservations while uploading, so concurrent uploads cannot
promise the same remaining capacity. Migration 0074 adds nullable expected
size/hash columns and a `versions` mutex row. Short database transactions lock
that row across reservations, bounded disk commits and retirement, coordinating
API workers and legacy writes. Network receipt and full-file hashing happen
outside database transactions.

Each request streams to a unique temporary block on the same volume. A disconnect
leaves the previous confirmed offset intact. Committing discards any uncommitted
tail, writes the block, syncs the file, then advances metadata. Concurrent writers
at one offset yield one accepted commit; the other resumes from current metadata.
At most one block per in-flight request is staged, in addition to reserved file
storage. A full disk fails the request without confirming its bytes.

Expiry and deletion share the commit lock, preventing an in-flight request from
resurrecting a retired transfer. Staging files are removed on request completion;
the existing orphan reaper collects those left by a killed process. Already-open
downloads may finish after unlink; new downloads are denied. Fetch attempts are
audited, and successful binary response completion increments the download count.

Deploy the API/migration before the new wrapper. Existing MCP clients continue to
work. Check storage ownership, free space, proxy request limits (at least 16 MiB),
streaming without full response buffering and inactivity timeouts. A production
acceptance must move a file between two hosts and verify hashes; local tests do
not establish production proxy or network behavior.

## Verification

The regular API tests exercise host/engine/module gates, bytes, ranges, empty
files, quota reservations, corruption, interrupted retries and retirement races.
Go tests cover lost upload responses, partial download resume, source changes,
no-clobber publication and integrity failures. Communicator tests stream a
16 MiB request without the 8 MiB control buffer.

Against a disposable MySQL initialized with the repository baseline/migrations:

```sh
cd api
TEST_USE_DB=1 TEST_DATABASE_URL=mysql://... \
  TEST_BINARY_TRANSFER_LARGE=1 npx vitest run test/integration/transfers/binary.test.ts
```

The explicit large-file option runs the real Go client against Fastify/TCP,
files and MySQL with 0-byte, 80 MiB and 3 GiB files, checks complete hashes and
bounds memory growth. The small MySQL concurrency case runs with normal DB tests.
