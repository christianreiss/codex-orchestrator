# Native Kimi model consumer fixtures

Unmodified MIT-licensed upstream source, fetched 2026-11-17 from
`MoonshotAI/kimi-code`, release `@moonshot-ai/kimi-code@2.6.3`, commit
`b0de2fbd2de04d87689225aafd3912e5d193b62d`:

- `packages/agent-core-v2/src/llm-adapter/model/catalog-runtime.ts`:
  SHA256 `cbe6db10d881b0fe8afbdefd6e75bf3a6284084a3ddc5b5cd4a0b8361c14c8ab`.
- `packages/agent-core-v2/src/llm-adapter/model/thinking.ts`:
  SHA256 `6172f923db96ac3c5c03e1e64752dbf09e7b8da16c07aeb91323a50a9b36a266`.

Both files are byte-identical to release 2.6.2, commit
`6a8493df3e1d796a63f7c7ca0de76c1e690cd943`. The test verifies the digests,
extracts function declarations with the TypeScript parser, transpiles them and
executes the actual pure consumer functions without the application's DI graph.
No network, account, auth refresh or inference is involved.

The model-specific declarations are checked against the
[official model table](https://www.kimi.com/code/docs/en/kimi-code/models.html),
accessed 2026-11-17. A static registry does not establish account entitlement.
