/**
 * Zod schemas for the user create / edit dialog.
 *
 * Server-side validation lives in `AdminUserService`. These schemas are a
 * client-side mirror: they catch obvious mistakes before submit and give
 * inline feedback. The server's response is still treated as authoritative.
 */
import { z } from "zod";
import { USER_ROLES, type UserRole } from "$lib/api/types";

const USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;

const passwordCharacterMix = (value: string): boolean => {
  if (value.length < 12) return false;
  let classes = 0;
  if (/[a-z]/.test(value)) classes++;
  if (/[A-Z]/.test(value)) classes++;
  if (/\d/.test(value)) classes++;
  if (/[^A-Za-z0-9]/.test(value)) classes++;
  return classes >= 2;
};

export const passwordSchema = z
  .string()
  .min(12, "Must be at least 12 characters")
  .refine(passwordCharacterMix, "Mix at least two of: lowercase, uppercase, digit, symbol");

const baseShape = {
  name: z
    .string()
    .max(120, "Name is too long")
    .optional()
    .transform((v) => v?.trim() ?? ""),
  username: z
    .string()
    .min(3, "At least 3 characters")
    .max(64, "Too long")
    .regex(USERNAME_PATTERN, "Lowercase letters, digits, . _ - only"),
  email: z
    .string()
    .email("Invalid email address")
    .or(z.literal("").transform(() => ""))
    .optional()
    .transform((v) => v?.trim() ?? ""),
  access_level: z.enum(USER_ROLES, {
    errorMap: () => ({ message: "Pick a role" }),
  }),
  active: z.boolean(),
};

export const createUserSchema = z
  .object({
    ...baseShape,
    password: passwordSchema,
    password_confirm: z.string(),
  })
  .refine((data) => data.password === data.password_confirm, {
    message: "Passwords do not match",
    path: ["password_confirm"],
  });

export const editUserSchema = z
  .object({
    ...baseShape,
    password: z.string().optional().default(""),
    password_confirm: z.string().optional().default(""),
  })
  .refine((data) => !data.password || passwordCharacterMix(data.password), {
    message: "Must be ≥ 12 chars with two character classes",
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
