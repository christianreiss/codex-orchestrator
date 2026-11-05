import { describe, expect, it } from 'vitest';
import { normalizeAddressForm, renderAddressFormMarkdown } from '../../../src/services/agent-address-form.js';

describe('address form', () => {
  it('defaults to informal for anything unknown', () => {
    for (const v of [undefined, null, '', 'du', 42, 'FORMAL?']) expect(normalizeAddressForm(v)).toBe('informal');
    expect(normalizeAddressForm(' Formal ')).toBe('formal');
  });
  it('renders an explicit rule per form', () => {
    expect(renderAddressFormMarkdown('informal')).toContain('"du" (never "Sie")');
    expect(renderAddressFormMarkdown('formal')).toContain('"Sie" (never "du")');
    expect(renderAddressFormMarkdown('informal').startsWith('## Address Form')).toBe(true);
  });
});
