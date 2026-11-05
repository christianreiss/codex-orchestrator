/**
 * Formal vs informal address, fleet-wide.
 *
 * The setting only matters in languages that distinguish the two (German
 * "du"/"Sie", French "tu"/"vous", ...). Models drift towards the formal form on
 * their own, so the default is spelled out rather than left implicit: an
 * informal fleet gets an explicit instruction, a formal one gets the opposite.
 * Rendered as one short section of the managed policy block for every engine.
 */

export const ADDRESS_FORMS = ['informal', 'formal'] as const;
export type AddressForm = (typeof ADDRESS_FORMS)[number];

export const DEFAULT_ADDRESS_FORM: AddressForm = 'informal';

/** SettingsService key for the fleet-wide address form (versions table). */
export const ADDRESS_FORM_SETTINGS_KEY = 'agent_address_form';

export const ADDRESS_FORM_HEADING = '## Address Form';

export const ADDRESS_FORM_DEFINITIONS: readonly { form: AddressForm; label: string; description: string }[] = [
  { form: 'informal', label: 'Informal (du)', description: 'Address the user informally: German "du", the informal second person elsewhere.' },
  { form: 'formal', label: 'Formal (Sie)', description: 'Address the user formally: German "Sie", the formal second person elsewhere.' },
];

export function normalizeAddressForm(input: unknown): AddressForm {
  const value = typeof input === 'string' ? input.trim().toLowerCase() : '';
  return (ADDRESS_FORMS as readonly string[]).includes(value) ? (value as AddressForm) : DEFAULT_ADDRESS_FORM;
}

/** The policy section for a form; always present, never empty. */
export function renderAddressFormMarkdown(form: AddressForm): string {
  const rule =
    form === 'formal'
      ? 'Address the user formally: German "Sie" (never "du"); the formal second person elsewhere.'
      : 'Address the user informally: German "du" (never "Sie"); the informal second person elsewhere. Do not drift into the formal form.';
  return `${ADDRESS_FORM_HEADING}\n\n- ${rule} An explicit request from the user wins.`;
}
