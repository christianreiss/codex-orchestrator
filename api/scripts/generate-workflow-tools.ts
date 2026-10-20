/** Regenerate cxx-agent schemas from the authoritative Zod workflow operation contracts. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { ZodTypeAny } from 'zod';
import { workflowToolSchema } from '../src/services/workflow-tool-schemas.js';
type JsonSchema = Record<string, unknown>;

const contract = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : new URL('../src/services/workflows/contract.js', import.meta.url).href) as { workflowMutationSchemas: Record<string, ZodTypeAny> };
const path = fileURLToPath(new URL('../../wrappers/cxx/internal/agentbus/workflows.go', import.meta.url));
const source = await readFile(path, 'utf8');
const marker = 'const workflowToolDefinitions = `';
const index = source.indexOf(marker);
const tools = JSON.parse(source.slice(index + marker.length).trim().slice(0, -1)) as { name: string; inputSchema: JsonSchema }[];
for (const tool of tools) {
  const operation = tool.name.slice('agent_workflow_'.length);
  if (operation !== 'run_current') tool.inputSchema = { type: 'object', ...workflowToolSchema(contract.workflowMutationSchemas[operation]!) };
}
await writeFile(path, source.slice(0, index) + marker + JSON.stringify(tools, null, 2) + '`\n');
