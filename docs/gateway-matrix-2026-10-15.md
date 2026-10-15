# Gateway acceptance, 2026-10-15

All nine API surface/backend combinations passed real-provider acceptance:
141 checks and 59 successful native runner executions. The machine-readable
[receipt](evidence/gateway-matrix-2026-10-15.json) includes every check, fresh
arithmetic challenge, output, dispatch engine/model, credential-engine match,
HTTP status and elapsed time.

| API surface | Codex | Claude | Grok |
| --- | --- | --- | --- |
| `/v1` | PASS, 6 generations | PASS, 7 generations | PASS, 5 generations |
| `/anthropic/v1` | PASS, 9 generations | PASS, 8 generations | PASS, 6 generations |
| `/grok/v1` | PASS, 7 generations | PASS, 7 generations | PASS, 4 generations |

Tested source: `37ac633a5a7c691e2cd58f4b64f340084c380dd2`, which combines
the Codex runner fix with the committed per-key backend routing work.
The receipt binds the verifier's SHA-256 and the exact tested image:
`sha256:27fc893237a0c82a23e0cca47a628f2d73cb5452aa57c8cfebcdcb31655954e2`.
Installed CLIs: Codex 0.162.1, Claude 2.1.296, Grok 1.0.50; linux/amd64.

## What passed

- Assigned-key routing for every combination while each endpoint default
  deliberately points to another engine; unassigned-key model discovery and
  generation for all nine endpoint-default combinations.
- `/chat/completions`, `/completions` and `/responses` on both OpenAI-wire
  surfaces; `/messages`, `/complete`, `/completions` and `/responses` on the
  Anthropic wire. Every response contains the correct newly computed sum.
- Every supported stream on Codex/Claude, including content reconstruction
  and terminal SSE framing; model list/retrieve, foreign native-model fallback,
  incorrect key namespaces, unknown models and effective-backend master switches.
- Anthropic token estimation and declared unsupported-operation responses.
  Grok streaming and Responses streaming return 400. Embeddings remain
  unsupported: 400 on OpenAI/Grok wires, 501 on the Anthropic wire.

## Fix and verification

The deployed Codex 0.154.0 runner rejected `gpt-6.1-sol` despite valid gateway
authentication and successful model listing. The runner now pins 0.162.1 with
published amd64/arm64 archive digests. Native failures preserve their last
500 diagnostic characters, keeping the provider error after long CLI banners.
The diagnostic regression failed before that change and passes afterward.

API typecheck, build and focused verifier lint passed; 95 routing/adapter tests
and 211 runner tests passed. The complete API lint run had zero errors and
140 existing warnings. The runner Docker image built successfully; all 211
runner tests also passed inside its Python 3.12 environment before integration.

The initial arbitrary-marker echo test produced 13 content refusals across
42 successful HTTP/runner calls, principally from Grok. A fresh arithmetic
question provides a content check without requesting an arbitrary-token echo.
The final receipt contains no failed or retried checks.

## Acceptance boundary and reproduction

The verifier uses isolated MySQL, real gateway key services, production route,
model and adapter code, real HTTP sockets and the rebuilt runner image. Enabled,
verified canonical snapshots were read from docker01.uggs.io and made
refresh-incapable before entering the test process. Auth snapshot injection
replaces production account selection/refresh; those lifecycle paths are outside
this receipt. No production configuration or running service was changed.

Run `api/scripts/verify-gateway-matrix.ts` as described in
[auth-runner.md](auth-runner.md#live-gateway-acceptance-matrix). Production rollout
and fresh calls through the public deployment remain separate acceptance steps.
