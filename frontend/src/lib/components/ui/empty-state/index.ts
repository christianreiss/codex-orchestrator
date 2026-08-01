import Root from "./EmptyState.svelte";
import { tv, type VariantProps } from "tailwind-variants";

export const emptyStateVariants = tv({
  base: "flex flex-col items-center justify-center text-center",
  variants: {
    size: {
      default: "px-6 py-12",
      sm: "px-3 py-6",
    },
  },
  defaultVariants: { size: "default" },
});

export type EmptyStateSize = VariantProps<typeof emptyStateVariants>["size"];
export { Root, Root as EmptyState };
