import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_MESSAGING_TOOLS } from '../../../src/services/agent-messaging-tool-names.js';

/**
 * The Claude permission allowlist approves exactly `AGENT_MESSAGING_TOOLS` on
 * the `cxx-agent` server. A tool the wrapper serves but the array lacks
 * prompts on every call on a Claude host whose posture is not auto/bypass
 * (2026-11-20: `agent_accept`, `agent_git_remote` and all 13
 * `agent_workflow_*` tools were missing). This pins the array to the
 * catalogue `cxx agent mcp` actually builds in `toolCatalogJSON()`.
 */
const agentbus = new URL('../../../../wrappers/cxx/internal/agentbus/', import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, agentbus), 'utf8');

/** `tool("name", ...)` definitions: the core list in mcp.go plus the appended groups. */
const TOOL_SOURCES = ['mcp.go', 'agent_chat.go', 'coordination.go', 'roles.go'];
const defined = TOOL_SOURCES.flatMap((file) =>
  [...read(file).matchAll(/\btool\("([a-z0-9_]+)"/g)].map((match) => match[1]!),
);

/** workflowTools() parses one JSON literal; same extraction as workflow-tool-schemas.test.ts. */
const workflowSource = read('workflows.go');
const marker = 'const workflowToolDefinitions = `';
const workflowTools = (
  JSON.parse(workflowSource.slice(workflowSource.indexOf(marker) + marker.length).trim().slice(0, -1)) as {
    name: string;
  }[]
).map((tool) => tool.name);

const served = [...defined, ...workflowTools];

/** The Go catalogue test pins the exact count, so a tool declared in a shape the regex misses still fails here. */
const pinned = Number(/len\(catalog\) != (\d+)/.exec(read('mcp_catalog_compatibility_test.go'))?.[1]);

describe('cxx-agent tool catalogue', () => {
  it('extracts every tool the wrapper serves', () => {
    expect(Number.isInteger(pinned)).toBe(true);
    expect(new Set(served).size).toBe(served.length);
    expect(served.length).toBe(pinned);
  });

  it('keeps AGENT_MESSAGING_TOOLS equal to the served catalogue', () => {
    const listed = [...AGENT_MESSAGING_TOOLS];
    expect(new Set(listed).size, 'AGENT_MESSAGING_TOOLS has duplicates').toBe(listed.length);
    expect(
      served.filter((name) => !listed.includes(name as never)).sort(),
      'served by wrappers/cxx/internal/agentbus but missing from agent-messaging-tool-names.ts (no permission rule)',
    ).toEqual([]);
    expect(
      listed.filter((name) => !served.includes(name)).sort(),
      'listed in agent-messaging-tool-names.ts but not served by the wrapper',
    ).toEqual([]);
  });
});
