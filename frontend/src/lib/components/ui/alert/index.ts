import Root from "./alert.svelte";
import Title from "./alert-title.svelte";
import Description from "./alert-description.svelte";
import { tv, type VariantProps } from "tailwind-variants";

export const alertVariants = tv({
  base: "relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground",
  variants: {
    variant: {
      default: "bg-background text-foreground",
      destructive: "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive",
      warning: "border-amber-500/50 text-amber-600 dark:text-amber-400 [&>svg]:text-amber-500",
      info: "border-blue-500/50 text-blue-600 dark:text-blue-400 [&>svg]:text-blue-500",
    },
  },
  defaultVariants: { variant: "default" },
});

export type AlertVariant = VariantProps<typeof alertVariants>["variant"];
export {
  Root,
  Title,
  Description,
  Root as Alert,
  Title as AlertTitle,
  Description as AlertDescription,
};
