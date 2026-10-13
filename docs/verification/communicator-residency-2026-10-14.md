# Private resident-runtime verification, 2026-10-14

Source worktree: `task/communicator-resident-b50a538a`, based on verified audit
`dc92e547178fb8a5207665ebe9c54db19da0f39d`. No release version allocated,
shared branch moved, production host updated, or fleet capability enabled.

## Source and UI checks

- Canonical normal Go suite and build passed; targeted resident, namespace,
  controller, migration and pinned-process tests passed with the race detector.
- API typecheck/build and lifecycle/spawn/signed-config unit tests passed.
- Frontend check passed with zero errors/warnings and 928 tests; production SPA
  build and the independent residence-settings Playwright test passed.
- Darwin CLI cross-build passed; systemd residence/migration remains Linux-only.
- The signed process fixture adopted an idle on-demand owner and verified source
  exit, successor PID/UUID and completed journal without any `/auth` request.

## Isolated real systemd lab

A task-owned rootless Podman container ran Fedora 43/systemd. Its base image ID
was `75126c04c57c`; the systemd image was
`7fc3e49b1bc846e1174b042109c2ce0d8761a3a94cce951d87453b239f5ad6b3`.
No host systemd unit, host daemon binary or production API was mounted into it.
The lab used three synthetic signed engine configurations, explicit residence,
disabled execution/transport/content sync, and a loopback HTTP stub for settings
and migration. This verifies real service/process behavior, not provider execution
or actual MySQL admission concurrency.

Fresh installation started a resident with zero local clients and HTTPS fallback.
The first update replaced source PID 195/owner
`f6c1314a-2aa4-46e5-9c30-fa5fbc02de8f` and reached `reopened` under transition
`f59e5a3c-e6ec-4ce0-a81d-f7e0fa43e205`. All API fence/status/release requests
used that same ID. Running source bytes were
`ee379bc48d6d2341d024e6674545628a443c360a25ac6c475e79452c97c33092`;
the target bytes were
`cf33d307e8c4b144781f557330f9369aefb06dac8a39efdcc8e438af9b750dfb`.

A second update and reverse rollback passed. Rollback transition
`959f06ad-cb97-4301-90c0-6a15df3dd490` restored the previous binary to PID 666,
owner `db30cdcc-ab89-4515-873d-3e21bee68a4f`. Repeating rollback returned success
without replacing that owner.

The stub then returned HTTP 503 for admission release. Update transition
`e7be6b27-0039-444d-a0c2-4f4c4720b56f` remained at `verified`. Removing that
failure and repeating install reached `reopened` with the same transition ID,
owner `97a08b47-3619-4471-b1ec-9eab876c883c` and PID 886. The retry did not
restart the verified target. Its executable hash was
`579e674122305d1c0e745431af4756b478642e46ccd807fd6f2e5ae4a471f70b`.

Both source and target unit artifacts had hash
`0d59d2923f7826592a0bb51e759c4d253696b044d05ca6df59a0889c1f5bb385`.
The binary changes alone therefore exercised actual running-byte detection.

## Remaining acceptance

Negotiated actual dashboard owner metadata, combined remote execution/receipt
recovery for every engine, database concurrency checks, independent migration
review and Director integration remain outstanding. Incompatible/unresponsive
legacy owners and custom systemd namespace changes intentionally defer. None of
these results is a production rollout receipt.
