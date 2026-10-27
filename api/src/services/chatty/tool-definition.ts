import { z } from 'zod';
import type { Capability } from '../../security/capabilities.js';
import type { ToolContext, ChattyTool } from './tools.js';

/** The subset of Zod used in this registry; unknown types fail at registration. */
export function jsonSchema(s: z.ZodTypeAny): Record<string, unknown> {
  const d = s._def;
  if (s instanceof z.ZodOptional || s instanceof z.ZodDefault) return jsonSchema(d.innerType);
  if (s instanceof z.ZodNullable) return { anyOf: [jsonSchema(d.innerType), { type: 'null' }] };
  if (s instanceof z.ZodEffects) return jsonSchema(d.schema);
  if (s instanceof z.ZodUnknown) return {};
  if (s instanceof z.ZodUnion) return { anyOf: d.options.map(jsonSchema) };
  if (s instanceof z.ZodDiscriminatedUnion) return { oneOf: [...d.options.values()].map(jsonSchema) };
  if (s instanceof z.ZodString)
    return {
      type: 'string',
      ...(d.description ? { description: d.description } : {}),
      ...Object.fromEntries(
        d.checks
          .filter((c: { kind: string }) => ['min', 'max'].includes(c.kind))
          .map((c: { kind: string; value: number }) => [
            c.kind === 'min' ? 'minLength' : 'maxLength',
            c.value,
          ]),
      ),
    };
  if (s instanceof z.ZodNumber)
    return { type: d.checks.some((c: { kind: string }) => c.kind === 'int') ? 'integer' : 'number' };
  if (s instanceof z.ZodBoolean) return { type: 'boolean' };
  if (s instanceof z.ZodEnum) return { type: 'string', enum: d.values };
  if (s instanceof z.ZodLiteral) return { const: d.value };
  if (s instanceof z.ZodRecord) return { type: 'object', additionalProperties: true };
  if (s instanceof z.ZodArray) return { type: 'array', items: jsonSchema(d.type) };
  if (s instanceof z.ZodObject) {
    const fields = d.shape() as Record<string, z.ZodTypeAny>;
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, jsonSchema(v)])),
      required: Object.entries(fields)
        .filter(([, v]) => !v.isOptional())
        .map(([k]) => k),
      additionalProperties: false,
    };
  }
  throw new Error(`Unsupported Chatty tool schema: ${d.typeName}`);
}

export function define<S extends z.ZodRawShape>(
  name: string,
  description: string,
  capability: Capability,
  shape: S,
  run: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  options: {
    confirm?: boolean;
    snapshot?: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
    href?: (args: z.infer<z.ZodObject<S>>) => string;
  } = {},
): ChattyTool {
  const schema = z.object(shape).strict();
  return {
    name,
    description,
    capability,
    parameters: jsonSchema(schema),
    write: !!options.snapshot,
    confirm: options.confirm ?? false,
    parse: (args) => schema.parse(args),
    run: (ctx, args) => run(ctx, schema.parse(args)),
    snapshot: options.snapshot ? (ctx, args) => options.snapshot!(ctx, schema.parse(args)) : undefined,
    href: options.href ? (args) => options.href!(schema.parse(args)) : undefined,
  };
}
