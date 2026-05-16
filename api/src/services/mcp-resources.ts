/**
 * MCP resource URI routing.
 *
 * Supports three URI families:
 *   - `memory://<key>`     — host-scoped MCP memory
 *   - `project://<slug>`   — shared project (bootstrap payload)
 *   - `skill://<slug>`     — skill manifest
 */
import type { Host } from '../db/schema.js';
import type { McpMemoriesService } from './mcp-memories.js';
import type { HostProjectsService } from './host-projects.js';
import type { HostSkillsService } from './host-skills.js';
import { ENGINE_CODEX } from '../util/engine.js';

export interface ResourceDeps {
  memories: McpMemoriesService;
  projects: HostProjectsService;
  skills: HostSkillsService;
}

export interface ResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceContent {
  uri: string;
  name?: string;
  mimeType?: string;
  text?: string;
  json?: unknown;
}

export interface ResourceReadResponse {
  contents: Array<ResourceContent>;
}

const URI_RE = /^([a-z]+):\/\/(.+)$/;

function parseUri(uri: string): { scheme: string; id: string } {
  const m = URI_RE.exec(uri);
  if (!m || !m[1] || !m[2]) throw new Error('Invalid resource URI: ' + uri);
  return { scheme: m[1], id: decodeURIComponent(m[2]) };
}

export class McpResourcesService {
  constructor(private readonly deps: ResourceDeps) {}

  listTemplates(): Array<Record<string, unknown>> {
    return [
      { uriTemplate: 'memory://{key}', name: 'memory', description: 'Host-scoped MCP memory by key', mimeType: 'application/json' },
      { uriTemplate: 'project://{slug}', name: 'project', description: 'Shared project (bootstrap payload)', mimeType: 'application/json' },
      { uriTemplate: 'skill://{slug}', name: 'skill', description: 'Skill manifest by slug', mimeType: 'text/markdown' },
    ];
  }

  async list(host: Host): Promise<ResourceDescriptor[]> {
    const [projects, skills] = await Promise.all([
      this.deps.projects.listProjects(host),
      this.deps.skills.listSkills(host, ENGINE_CODEX),
    ]);
    const resources: ResourceDescriptor[] = [];
    for (const p of projects.projects) {
      resources.push({
        uri: `project://${encodeURIComponent(p.slug)}`,
        name: p.title,
        description: p.description,
        mimeType: 'application/json',
      });
    }
    for (const s of skills.skills as Array<Record<string, unknown>>) {
      const slug = String(s['slug'] ?? '');
      if (!slug) continue;
      resources.push({
        uri: `skill://${encodeURIComponent(slug)}`,
        name: String(s['display_name'] ?? slug),
        description: typeof s['description'] === 'string' ? (s['description'] as string) : '',
        mimeType: 'text/markdown',
      });
    }
    return resources;
  }

  async read(uri: string, host: Host): Promise<ResourceReadResponse> {
    const { scheme, id } = parseUri(uri);
    if (scheme === 'memory') {
      const result = await this.deps.memories.retrieve({ id }, host);
      return {
        contents: [
          {
            uri,
            name: id,
            mimeType: 'application/json',
            text: JSON.stringify(result),
          },
        ],
      };
    }
    if (scheme === 'project') {
      const bootstrap = await this.deps.projects.bootstrap(id, host);
      return {
        contents: [
          { uri, name: id, mimeType: 'application/json', text: JSON.stringify(bootstrap) },
        ],
      };
    }
    if (scheme === 'skill') {
      const skill = await this.deps.skills.retrieve(id, null, host);
      const manifest = typeof skill['manifest'] === 'string' ? (skill['manifest'] as string) : JSON.stringify(skill);
      return {
        contents: [
          { uri, name: id, mimeType: 'text/markdown', text: manifest },
        ],
      };
    }
    throw new Error('Unsupported resource scheme: ' + scheme);
  }

  async create(uri: string, params: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const { scheme, id } = parseUri(uri);
    if (scheme !== 'memory') throw new Error('Only memory:// resources can be created');
    const text = typeof params['text'] === 'string' ? (params['text'] as string) : '';
    return (await this.deps.memories.store({ id, content: text }, host)) as Record<string, unknown>;
  }

  async update(uri: string, params: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    return this.create(uri, params, host);
  }

  async delete(uri: string, host: Host): Promise<Record<string, unknown>> {
    const { scheme, id } = parseUri(uri);
    if (scheme !== 'memory') throw new Error('Only memory:// resources can be deleted');
    return (await this.deps.memories.delete({ id }, host)) as Record<string, unknown>;
  }
}
