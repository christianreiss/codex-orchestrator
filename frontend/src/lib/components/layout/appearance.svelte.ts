import { fromStore, get } from "svelte/store";
import { createMutation, useQueryClient } from "@tanstack/svelte-query";
import { toast } from "svelte-sonner";
import { accountKeys, setTheme as persistTheme } from "$lib/api/account";
import { setTheme, themeStore, type ThemeChoice } from "$lib/stores/theme";

/**
 * The quick light/dark/system switch of the shell. `AppShell` creates one
 * instance: the account menu changes the theme, and the top bar keeps a failed
 * save visible after the menu and its toast are gone (INT-5). The change is
 * applied optimistically and rolled back when the server refuses it.
 */
export function createAppearanceControl() {
  const qc = useQueryClient();
  let attempted = $state<ThemeChoice>("system");
  const mutation = createMutation({
    mutationFn: (value: ThemeChoice) => persistTheme(value === "system" ? "auto" : value),
    onMutate: async (value: ThemeChoice) => {
      attempted = value;
      const previous = get(themeStore);
      await qc.cancelQueries({ queryKey: accountKeys.theme });
      setTheme(value);
      qc.setQueryData(accountKeys.theme, { theme: value === "system" ? "auto" : value });
      return { previous };
    },
    onSuccess: (data) => qc.setQueryData(accountKeys.theme, data),
    onError: (error, _value, context) => {
      if (context) {
        setTheme(context.previous);
        qc.setQueryData(accountKeys.theme, { theme: context.previous === "system" ? "auto" : context.previous });
      }
      toast.error("Could not save appearance", { description: error.message });
    },
  });

  const result = fromStore(mutation);

  return {
    /** A save is in flight; the switch is disabled meanwhile. */
    get pending(): boolean {
      return result.current.isPending;
    },
    /** The last save failed and the previous appearance was restored. */
    get failed(): boolean {
      return result.current.isError;
    },
    choose(value: string): void {
      if (value === "light" || value === "dark" || value === "system") get(mutation).mutate(value);
    },
    retry(): void {
      get(mutation).mutate(attempted);
    },
  };
}

export type AppearanceControl = ReturnType<typeof createAppearanceControl>;
