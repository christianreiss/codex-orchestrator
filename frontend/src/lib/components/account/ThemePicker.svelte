<script lang="ts">
  /** The only place with every theme option; the top bar keeps a quick light/dark/system toggle. */
  import { toast } from "svelte-sonner";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { mode } from "mode-watcher";
  import { Label } from "$lib/components/ui/label";
  import { RadioGroup, RadioGroupItem } from "$lib/components/ui/radio-group";
  import { ApiError } from "$lib/api/client";
  import { accountKeys, getTheme, setTheme as persistTheme } from "$lib/api/account";
  import { normalizeThemeChoice, setTheme as setLocalTheme, themeStore, type ThemeChoice } from "$lib/stores/theme";
  import Sun from "@lucide/svelte/icons/sun";
  import Moon from "@lucide/svelte/icons/moon";
  import Monitor from "@lucide/svelte/icons/monitor";

  const qc = useQueryClient();
  const themeQuery = createQuery({ queryKey: accountKeys.theme, queryFn: () => getTheme() });
  const selected = $derived($themeStore);
  let seeded = $state(false);
  $effect(() => {
    const next = normalizeThemeChoice($themeQuery.data?.theme);
    if (next && !seeded) {
      setLocalTheme(next);
      seeded = true;
    }
  });
  const mutation = createMutation({
    mutationFn: (value: ThemeChoice) => persistTheme(value === "system" ? "auto" : value),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: accountKeys.theme });
      toast.success("Appearance saved");
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save appearance."),
  });
  function choose(value: string) {
    if (value !== "light" && value !== "dark" && value !== "system") return;
    setLocalTheme(value);
    $mutation.mutate(value);
  }
  const options: Array<{ value: ThemeChoice; label: string; description: string; icon: typeof Sun }> = [
    { value: "system", label: "System", description: "Follow the operating system setting.", icon: Monitor },
    { value: "light", label: "Light", description: "Light console surface.", icon: Sun },
    { value: "dark", label: "Dark", description: "Dark console surface.", icon: Moon },
  ];
  const resolved = $derived(mode.current ?? null);
</script>

{#if $themeQuery.isError}
  <p class="text-body-sm text-destructive" role="alert">
    {$themeQuery.error instanceof Error ? $themeQuery.error.message : "Failed to load appearance preference."}
  </p>
{:else}
  <RadioGroup value={selected} onValueChange={choose} disabled={$themeQuery.isLoading || $mutation.isPending} class="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="Theme">
    {#each options as option (option.value)}
      {@const Icon = option.icon}
      <Label for={`theme-${option.value}`} class="flex min-h-16 cursor-pointer items-center gap-3 rounded-md border p-3 hover:bg-muted/50 has-[[data-state=checked]]:border-primary">
        <RadioGroupItem id={`theme-${option.value}`} value={option.value} />
        <Icon class="h-4 w-4 text-muted-foreground" />
        <span>
          <span class="block text-body font-medium">{option.label}</span>
          <span class="block text-body-sm font-normal text-muted-foreground">{option.description}</span>
        </span>
      </Label>
    {/each}
  </RadioGroup>
  <p class="mt-3 text-body-sm text-muted-foreground" role="status">
    {#if $themeQuery.isPending}Loading appearance…
    {:else if $mutation.isPending}Saving appearance…
    {:else if $mutation.isError}Preview applied on this device; account preference was not confirmed.
    {:else if $mutation.isSuccess}Appearance saved to your account.
    {:else}Changes save immediately to your account.{/if}
    {#if resolved} Rendering in <span class="font-medium text-foreground">{resolved}</span> mode.{/if}
  </p>
  {#if $mutation.isError}
    <p class="mt-2 text-body-sm text-destructive" role="alert">{$mutation.error instanceof Error ? $mutation.error.message : "Could not save appearance."} Select an option to try again.</p>
  {/if}
{/if}
