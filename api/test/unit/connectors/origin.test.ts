import { expect, it } from 'vitest';
import { canonicalConnectorOrigin, canonicalDashboardOrigin } from '../../../src/util/connector-origin.js';
it('normalizes origins and rejects credential-bearing or non-root public issuers', () => {
  expect(canonicalConnectorOrigin('https://CONNECTORS.example:443/')).toBe('https://connectors.example');
  for (const value of [
    undefined,
    'http://example',
    'https://user:password@example',
    'https://example/path',
    'https://example/?x=1',
    'https://example/#fragment',
    'not a URL',
  ])
    expect(canonicalConnectorOrigin(value)).toBeNull();
  expect(canonicalDashboardOrigin('https://FLEET.example:443/base')).toBe('https://fleet.example');
  expect(canonicalDashboardOrigin('https://user:password@example')).toBeNull();
});
