/**
 * The client-side password policy, shared by the admin user dialog and the
 * self-service change page. One rule list for both: a password an owner sets
 * for a user must never be one the same user is refused when they later change
 * it themselves.
 *
 * The server enforces the length only (`PASSWORD_MIN_LENGTH` in
 * api/src/services/admin-auth.ts) and stays authoritative; the character mix is
 * a client-side nudge on top. `api/test/unit/contract/frontend-password-policy.test.ts`
 * pins the minimum below to the server's.
 */
import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 12;

const characterClasses = (value: string): number => {
  let classes = 0;
  if (/[a-z]/.test(value)) classes++;
  if (/[A-Z]/.test(value)) classes++;
  if (/\d/.test(value)) classes++;
  if (/[^A-Za-z0-9]/.test(value)) classes++;
  return classes;
};

/** The policy, in the order the account page's live checklist shows it. */
export const PASSWORD_RULES: { label: string; test: (value: string) => boolean }[] = [
  {
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    test: (value) => value.length >= PASSWORD_MIN_LENGTH,
  },
  {
    label: "Mixes at least two of: lowercase, uppercase, digit, symbol",
    test: (value) => characterClasses(value) >= 2,
  },
];

/** The same rules as one sentence, for form hints and card descriptions. */
export const PASSWORD_POLICY_TEXT = `At least ${PASSWORD_MIN_LENGTH} characters, mixing at least two of: lowercase, uppercase, digit, symbol.`;

export const isValidPassword = (value: string): boolean =>
  PASSWORD_RULES.every((rule) => rule.test(value));

export const passwordSchema = z.string().superRefine((value, ctx) => {
  for (const rule of PASSWORD_RULES) {
    if (!rule.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: rule.label });
    }
  }
});
