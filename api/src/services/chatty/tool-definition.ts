import { z } from 'zod';
import type { Capability } from '../../security/capabilities.js';
import type { ToolContext, ChattyTool } from './tools.js';

/** The subset of Zod used in this registry; unknown types fail at registration. */
export function jsonSchema(s: z.ZodTypeAny): Record<string, unknown> {
  if (s instanceof z.ZodOptional || s instanceof z.ZodDefault) return jsonSchema(s.unwrap() as z.ZodType);
  if (s instanceof z.ZodNullable) return { anyOf: [jsonSchema(s.unwrap() as z.ZodType), { type: 'null' }] };
  if (s instanceof z.ZodUnknown) return {};
  if (s instanceof z.ZodPipe) return jsonSchema(s.in as z.ZodType);
  if (s instanceof z.ZodDiscriminatedUnion) return { oneOf: s.options.map((v) => jsonSchema(v as z.ZodType)) };
  if (s instanceof z.ZodUnion) return { anyOf: s.options.map((v) => jsonSchema(v as z.ZodType)) };
  if (s instanceof z.ZodString || s instanceof z.ZodStringFormat) return {
    type: 'string',
    ...(s.description ? { description: s.description } : {}),
    ...(s.minLength !== null ? { minLength: s.minLength } : {}),
    ...(s.maxLength !== null ? { maxLength: s.maxLength } : {}),
  };
  if (s instanceof z.ZodNumber) return { type: s.isInt ? 'integer' : 'number' };
  if (s instanceof z.ZodBoolean) return { type: 'boolean' };
  if (s instanceof z.ZodEnum) return { type: 'string', enum: s.options };
  if (s instanceof z.ZodLiteral) return { const: s.value };
  if (s instanceof z.ZodRecord) return { type: 'object', additionalProperties: true };
  if (s instanceof z.ZodArray) return { type: 'array', items: jsonSchema(s.element as z.ZodType) };
  if (s instanceof z.ZodObject) {
    const fields = s.shape as Record<string, z.ZodType>;
    return {
      type: 'object', properties: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, jsonSchema(field)])),
      required: Object.entries(fields).filter(([, field]) => !field.isOptional()).map(([key]) => key),
      additionalProperties: false,
    };
  }
  throw new Error(`Unsupported Chatty tool schema: ${s.type}`);
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
