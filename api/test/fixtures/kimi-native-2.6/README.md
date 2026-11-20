# Native Kimi model consumer fixtures

The directory name is historical (it first held 2.6.x); the files below are the
2.7.2 consumer code.

Unmodified MIT-licensed upstream source, fetched 2026-11-20 from
`MoonshotAI/kimi-code`, release `@moonshot-ai/kimi-code@2.7.2`, commit
`56145f849caa305d42acd09b67fb65d11146f887`:

- `packages/agent-core-v2/src/llm-adapter/model/catalog-runtime.ts`:
  SHA256 `dd5fcd63e2a401a86022187e0a25372094d269771f01c16c7dacb5bd3c6d2874`.
- `packages/core/src/llm/thinking.ts`:
  SHA256 `fce8e63b44c56b0bb7b8c987cdf72d49419b76c9bd3b068dbedbab2d25b75b31`.

In 2.7.2 the thinking consumer moved from `agent-core-v2/src/llm-adapter/model/`
to `packages/core/src/llm/`, and both files now work on the nested `LlmModelSpec`
shape (`spec.capability`, `spec.thinking.*`) instead of the flat 2.6.x fields.
Upstream applies model `overrides` in `provider-catalog/catalog.ts`
(`applyModelOverrides`); that file is not fixtured, so the test carries a small
adapter that folds `overrides` into `spec` with the same precedence.

The test verifies the digests, extracts function declarations with the
TypeScript parser, transpiles them and executes the actual pure consumer
functions without the application's DI graph. No network, account, auth refresh
or inference is involved.

The model-specific declarations are checked against the
[official model table](https://www.kimi.com/code/docs/en/kimi-code/models.html),
accessed 2026-11-17 (model IDs re-checked 2026-11-20). A static registry does
not establish account entitlement.
