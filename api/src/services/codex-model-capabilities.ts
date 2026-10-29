/** Native Codex model capabilities, derived from the fleet model registry
 * (`model-registry/data.ts`, which records the catalog evidence). Shared by
 * structured and native-reference migrations; API effort semantics are separate. */
import { modelTable } from './model-registry/index.js';

export const MODEL_REASONING_EFFORTS: Readonly<Record<string, readonly string[]>> = modelTable('codex', (entry) => entry.efforts);

/** `default_reasoning_level` as the Codex CLI catalog reports it (Astra: operator decision). */
export const CODEX_MODEL_DEFAULT_REASONING_EFFORTS: Readonly<Record<string, string>> = modelTable(
  'codex',
  (entry) => entry.defaultEffort ?? undefined,
);

/** Native CLI availability, not an API model minimum. */
export const CODEX_MODEL_MIN_CLI_VERSIONS: Readonly<Record<string, string>> = modelTable('codex', (entry) => entry.minCliVersion);
