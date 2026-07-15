import Root from "./badge.svelte";
import { tv, type VariantProps } from "tailwind-variants";

export const badgeVariants = tv({
  base: "inline-flex min-h-5 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.01em] transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
      secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
      destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
      outline: "text-foreground",
      success: "border-emerald-500/15 bg-emerald-500/12 text-emerald-700 hover:bg-emerald-500/18 dark:text-emerald-300",
      warning: "border-amber-500/15 bg-amber-500/14 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300",
    },
  },
  defaultVariants: { variant: "default" },
});

export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
export { Root, Root as Badge };
