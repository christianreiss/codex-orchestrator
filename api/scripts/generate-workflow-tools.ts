/** Regenerate cxx-agent schemas from the authoritative Zod workflow operation contracts. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ZodTypeAny } from 'zod';

type JsonSchema = Record<string, unknown>;
function schema(value: ZodTypeAny): JsonSchema {
  const def = value._def;
  switch (def.typeName) {
    case 'ZodEffects': return schema(def.schema);
    case 'ZodDefault': return { ...schema(def.innerType), default: def.defaultValue() };
    case 'ZodOptional': return schema(def.innerType);
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      for (const check of def.checks) {
        if (check.kind === 'min') out.minLength = check.value;
        if (check.kind === 'max') out.maxLength = check.value;
        if (check.kind === 'uuid') out.format = 'uuid';
        if (check.kind === 'datetime') out.format = 'date-time';
        if (check.kind === 'regex') out.pattern = check.regex.source;
      }
      return out;
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: def.checks.some((c: { kind: string }) => c.kind === 'int') ? 'integer' : 'number' };
      for (const check of def.checks) if (check.kind === 'min' || check.kind === 'max')
        out[check.kind === 'min' ? (check.inclusive ? 'minimum' : 'exclusiveMinimum') : (check.inclusive ? 'maximum' : 'exclusiveMaximum')] = check.value;
      return out;
    }
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodLiteral': return { const: def.value, type: typeof def.value };
    case 'ZodEnum': return { type: 'string', enum: def.values };
    case 'ZodArray': return { type: 'array', items: schema(def.type), ...(def.minLength ? { minItems: def.minLength.value } : {}), ...(def.maxLength ? { maxItems: def.maxLength.value } : {}) };
    case 'ZodRecord': return { type: 'object', additionalProperties: schema(def.valueType) };
    case 'ZodUnknown': return {};
    case 'ZodObject': {
      const shape = def.shape() as Record<string, ZodTypeAny>;
      return { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([key, v]) => [key, schema(v)])),
        required: Object.entries(shape).filter(([, v]) => !v.isOptional()).map(([key]) => key), additionalProperties: def.unknownKeys !== 'strict' };
    }
    case 'ZodDiscriminatedUnion': return { oneOf: [...def.options.values()].map(schema) };
    case 'ZodUnion': return { anyOf: def.options.map(schema) };
    default: throw new Error(`Unsupported workflow schema ${String(def.typeName)}`);
  }
}
const contract = await import(pathToFileURL(resolve(process.argv[2] ?? 'src/services/workflows/contract.ts')).href) as { workflowMutationSchemas: Record<string, ZodTypeAny> };
const path = resolve('../wrappers/cxx/internal/agentbus/workflows.go');
const source = await readFile(path, 'utf8');
const marker = 'const workflowToolDefinitions = `';
const index = source.indexOf(marker);
const tools = JSON.parse(source.slice(index + marker.length).trim().slice(0, -1)) as { name: string; inputSchema: JsonSchema }[];
for (const tool of tools) {
  const operation = tool.name.slice('agent_workflow_'.length);
  if (operation !== 'run_current') tool.inputSchema = { type: 'object', ...schema(contract.workflowMutationSchemas[operation]!) };
}
await writeFile(path, source.slice(0, index) + marker + JSON.stringify(tools, null, 2) + '`\n');
