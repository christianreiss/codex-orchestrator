import { typographyMergeConfig } from "$lib/utils/cn";
import Root from "./badge.svelte";
import { tv, type VariantProps } from "tailwind-variants";

export const badgeVariants = tv({
  base: "inline-flex min-h-5 items-center rounded-md border px-2 py-0.5 text-caption font-semibold tracking-[0.01em]",
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground",
      secondary: "border-transparent bg-secondary text-secondary-foreground",
      destructive: "border-transparent bg-destructive text-destructive-foreground",
      outline: "text-foreground",
      success: "border-success/25 bg-success-muted text-success-muted-foreground",
      warning: "border-warning/25 bg-warning-muted text-warning-muted-foreground",
      info: "border-info/25 bg-info-muted text-info-muted-foreground",
    },
  },
  defaultVariants: { variant: "default" },
}, { twMergeConfig: typographyMergeConfig });

export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
export { Root, Root as Badge };
