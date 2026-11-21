import { z } from 'zod';

export function workflowToolSchema(value: z.ZodType): Record<string, unknown> {
  const schema = z.toJSONSchema(value, {
    io: 'input',
    target: 'draft-7',
    override({ jsonSchema }) {
      // Existing wrapper contracts advertise formats and explicit bounds.
      if (jsonSchema.format === 'uuid' || jsonSchema.format === 'date-time') delete jsonSchema.pattern;
      if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum;
      if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum;
      const keys = jsonSchema.propertyNames;
      if (keys && typeof keys === 'object' && keys.type === 'string' && Object.keys(keys).length === 1) delete jsonSchema.propertyNames;
    },
  });
  delete schema.$schema;
  return schema;
}
