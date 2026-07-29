/**
 * Zod schemas for the user create / edit dialog.
 *
 * Server-side validation lives in `AdminUserService`. These schemas are a
 * client-side mirror: they catch obvious mistakes before submit and give
 * inline feedback. The server's response is still treated as authoritative.
 *
 * The password rules come from `$lib/constants/password`, which the account
 * page's change form shares, so neither surface can reject what the other
 * accepts.
 */
import { z } from "zod";
import { USER_ROLES, type UserRole } from "$lib/api/types";
import { PASSWORD_POLICY_TEXT, isValidPassword, passwordSchema } from "$lib/constants/password";

const USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;

const baseShape = {
  username: z
    .string()
    .min(3, "At least 3 characters")
    .max(64, "Too long")
    .regex(USERNAME_PATTERN, "Lowercase letters, digits, . _ - only"),
  access_level: z.enum(USER_ROLES, {
    errorMap: () => ({ message: "Pick a role" }),
  }),
  active: z.boolean(),
};

// `AdminUserService.create` runs the body through normalizeName/normalizeEmail,
// which reject a blank or malformed value with a 400 — so the create form asks
// for both rather than posting what the server refuses.
// `api/test/unit/contract/frontend-user-form-required-fields.test.ts` pins these
// to the fields the create route declares required.
export const createUserSchema = z
  .object({
    ...baseShape,
    name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
    email: z.string().trim().min(1, "Email is required").email("Invalid email address"),
    password: passwordSchema,
    password_confirm: z.string(),
  })
  .refine((data) => data.password === data.password_confirm, {
    message: "Passwords do not match",
    path: ["password_confirm"],
  });

// The update route patches: every field of its schema is optional, and the
// dialog omits the ones left blank, so edit keeps the empty-string escape hatch.
export const editUserSchema = z
  .object({
    ...baseShape,
    name: z
      .string()
      .max(120, "Name is too long")
      .optional()
      .transform((v) => v?.trim() ?? ""),
    email: z
      .string()
      .email("Invalid email address")
      .or(z.literal("").transform(() => ""))
      .optional()
      .transform((v) => v?.trim() ?? ""),
    password: z.string().optional().default(""),
    password_confirm: z.string().optional().default(""),
  })
  .refine((data) => !data.password || isValidPassword(data.password), {
    message: PASSWORD_POLICY_TEXT,
    path: ["password"],
  })
  .refine((data) => (data.password ?? "") === (data.password_confirm ?? ""), {
    message: "Passwords do not match",
    path: ["password_confirm"],
  });

export const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "viewer", label: "Viewer" },
  { value: "fleet_operator", label: "Fleet Operator" },
  { value: "trusted_user", label: "Trusted User" },
  { value: "user", label: "User" },
];
