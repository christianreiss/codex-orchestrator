import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const compose = yaml.load(readFileSync(new URL('../../../../docker-compose.yml', import.meta.url), 'utf8')) as {
  services: Record<string, { volumes: string[]; network_mode: string; read_only: boolean }>;
};

describe('offline worker storage', () => {
  it.each([['media-worker', 'agent-chat'], ['slop-worker', 'slop/runs']])(
    '%s has writable access to its own queue',
    (serviceName, directory) => {
      const service = compose.services[serviceName]!;
      expect(service.volumes).toEqual([`\${DATA_ROOT:-/var/docker_data/codex-auth.example.com}/store/${directory}:/app/storage/${directory}`]);
      expect(service.network_mode).toBe('none');
      expect(service.read_only).toBe(true);
    },
  );
});
