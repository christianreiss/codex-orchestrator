import type { ZodTypeAny } from 'zod';

type JsonSchema = Record<string, unknown>;
export function workflowToolSchema(value: ZodTypeAny): JsonSchema {
  const def = value._def;
  switch (def.typeName) {
    case 'ZodEffects': return workflowToolSchema(def.schema);
    case 'ZodDefault': return { ...workflowToolSchema(def.innerType), default: def.defaultValue() };
    case 'ZodOptional': return workflowToolSchema(def.innerType);
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
    case 'ZodArray': return { type: 'array', items: workflowToolSchema(def.type), ...(def.minLength ? { minItems: def.minLength.value } : {}), ...(def.maxLength ? { maxItems: def.maxLength.value } : {}) };
    case 'ZodRecord': return { type: 'object', additionalProperties: workflowToolSchema(def.valueType) };
    case 'ZodUnknown': return {};
    case 'ZodObject': {
      const shape = def.shape() as Record<string, ZodTypeAny>;
      return { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([key, v]) => [key, workflowToolSchema(v)])),
        required: Object.entries(shape).filter(([, v]) => !v.isOptional()).map(([key]) => key), additionalProperties: def.unknownKeys !== 'strict' };
    }
    case 'ZodDiscriminatedUnion': return { oneOf: [...def.options.values()].map(workflowToolSchema) };
    case 'ZodUnion': return { anyOf: def.options.map(workflowToolSchema) };
    default: throw new Error(`Unsupported workflow schema ${String(def.typeName)}`);
  }
}
