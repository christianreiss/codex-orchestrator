import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

const CONTRACT_ROOT = new URL('../../../docs/contracts/', import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const require = createRequire(import.meta.url);
// A clean npm install may keep Fastify's Ajv under @fastify/ajv-compiler while
// this helper uses the root Ajv2020 entrypoint.  Those instances are runtime
// compatible, but their private TypeScript identities are not.  Keep the CJS
// interop boundary structural so container builds do not depend on npm's
// particular Ajv hoisting layout.
type ApplyFormats = (instance: unknown) => unknown;
const formatsPackage = require('ajv-formats') as ApplyFormats & { default?: ApplyFormats };
(formatsPackage.default ?? formatsPackage)(ajv);

const validators = new Map<string, ValidateFunction>();

export function compileContract(name: string): ValidateFunction {
  const cached = validators.get(name);
  if (cached) return cached;
  const schema = JSON.parse(readFileSync(new URL(name, CONTRACT_ROOT), 'utf8')) as object;
  const validator = ajv.compile(schema);
  validators.set(name, validator);
  return validator;
}

export function assertContract(name: string, payload: unknown): void {
  const validator = compileContract(name);
  if (validator(payload)) return;
  throw new Error(`${name} contract mismatch:\n${formatErrors(validator.errors)}`);
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('\n');
}
