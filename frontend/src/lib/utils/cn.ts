import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Custom typography names are sizes, not colors. Both cn and tailwind-variants
// must know this or text-body-sm silently removes text-primary-foreground.
export const typographyMergeConfig = {
  extend: { classGroups: { "font-size": [{ text: ["body", "body-sm", "caption", "overline", "body-lg", "h1", "h2", "h3"] }] } },
};
const merge = extendTailwindMerge(typographyMergeConfig);
export function cn(...inputs: ClassValue[]): string { return merge(clsx(inputs)); }
