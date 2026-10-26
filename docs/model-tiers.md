# Fleet model capability classes

Reviewed **2026-10-26** for the engine-maintenance run. Classes are the fleet's
task-routing judgment, not provider-certified ratings or an account-access claim.
They group capability across providers. Reasoning effort and serving speed remain
separate controls; a faster serving variant does not imply a weaker model.

## Grok corrections

| Model | Previous → current | Evidence and decision |
| --- | --- | --- |
| `grok-4.7` | 2 → 3 | Current coding and longer-task positioning, with engineering results comparable to the fleet's Sol class, supports cross-cutting engineering work. Mixed benchmark results do not justify Tier 4. |
| `grok-4.7-build-fast` | 1 → 3 | The native subscription model name is Grok 4.7 Fast. The provider identifies it as the same model on faster infrastructure, available in Build and Cursor. It therefore shares the standard variant's capability class. |
| `grok-4.6` | 1 → 2 | The provider describes sustained codebase work and application implementation; current comparative engineering results support feature work beyond mechanical edits. Tier 2 is a conservative placement. |
| `grok-4.5` | 1 → 2 | Its original engineering evaluations and application-building scope also exceed mechanical work. The current comparison retains substantial engineering capability; age alone is not evidence for Tier 1. |

Sources opened on the review date:

- [Grok 4.7 developer guide](https://docs.x.ai/developers/grok-4-7), updated
  2026-10-10, explicitly connects the standard and Fast variants and their Build scope.
- [Grok 4.7 announcement](https://x.ai/news/grok-4-7), 2026-09-21: CursorBench
  4.0 is 46.3% for 4.7 versus 41.7% for GPT-5.6 Sol; DeepSWE 1.1 is 71.0%
  versus 72.7%; Terminal-Bench 4.0 is 37.6% versus 37.3% and Fable 5.1's 57.9%.
  Different effort/harness conditions limit direct ranking. These mixed results
  support a conservative engineering class rather than a universal superiority claim.
- [Grok 4.6 announcement](https://x.ai/news/grok-4-6), 2026-08-12, describes
  longer agent trajectories and complete application work. Its reported engineering
  results and the newer 4.7 comparison support Tier 2.
- [Grok 4.5 announcement](https://x.ai/news/grok-4-5), 2026-07-16, includes
  multi-step engineering and end-to-end applications. The native model's age and
  low serving price do not reduce that scope to mechanical edits.

Exact Fast identity is corroborated by the existing native subscription catalog:
`grok-4.7-build-fast` has display name `Grok 4.7 Fast`, system-prompt label
`Grok 4.7`, and origin `https://cli-chat-proxy.grok.com/v1/models`.
That cached identity was fetched on 2026-10-03 using native 1.0.46; its SHA256 is
`d0452b3feb21351e10248dd4404ae647c98b61281065303e589ea8a99c7f3087`.
It corroborates naming, not current entitlement or current subscription capabilities.
The current official guide supplies the same-model relationship. Public API efforts
are not copied into the subscription catalog by this review.

## Retained family classes

Codex retains Luna 1, Terra 2, Sol 3 and Astra 4. Current
[model selection guidance](https://learn.chatgpt.com/docs/model-selection) and
[model documentation](https://learn.chatgpt.com/docs/models) distinguish focused
repeatable work, efficient everyday work, complex technical work and the most
demanding end-to-end reasoning. `gpt-6.1-terra` inherits the Terra class when its
separate catalog addition lands; this review does not alter its capability metadata.

Claude retains Haiku 1, Sonnet 2, Opus 3 and Fable 4. The current
[provider overview](https://platform.claude.com/docs/en/models/overview) positions
Haiku for latency-sensitive volume, Sonnet for balanced speed and intelligence,
Opus for sustained agentic coding, and Fable for demanding long-horizon reasoning.
No new evidence justified changing those family mappings.

The source table in `api/src/services/model-tiers.ts` drives managed Agents
previews, available-model recommendations and launch sorting. Tests require every
supported catalog entry to resolve to a class, preserve all four task definitions,
and render the updated shared table through each engine's actual preview service.
