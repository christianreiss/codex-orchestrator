<script lang="ts">
  import { toast } from "svelte-sonner";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { mode } from "mode-watcher";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Label } from "$lib/components/ui/label";
  import { RadioGroup, RadioGroupItem } from "$lib/components/ui/radio-group";
  import { ApiError } from "$lib/api/client";
  import { accountKeys, getTheme, setTheme as persistTheme } from "$lib/api/account";
  import { normalizeThemeChoice, setTheme as setLocalTheme, type ThemeChoice } from "$lib/stores/theme";
  import Sun from "@lucide/svelte/icons/sun";
  import Moon from "@lucide/svelte/icons/moon";
  import Monitor from "@lucide/svelte/icons/monitor";

  const qc = useQueryClient();
  const themeQuery = createQuery({ queryKey: accountKeys.theme, queryFn: () => getTheme() });
  let selected = $state<ThemeChoice>("system");
  let seeded = $state(false);
  $effect(() => {
    const next = normalizeThemeChoice($themeQuery.data?.theme);
    if (next && !seeded) { selected = next; setLocalTheme(next); seeded = true; }
  });
  const mutation = createMutation({
    mutationFn: (value: ThemeChoice) => persistTheme(value === "system" ? "auto" : value),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: accountKeys.theme }); toast.success("Appearance saved"); },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save appearance."),
  });
  function choose(value: string) {
    if (value !== "light" && value !== "dark" && value !== "system") return;
    selected = value;
    setLocalTheme(value);
    $mutation.mutate(value);
  }
  const options: Array<{ value: ThemeChoice; label: string; description: string; icon: typeof Sun }> = [
    { value: "system", label: "System", description: "Follow the operating system setting.", icon: Monitor },
    { value: "light", label: "Light", description: "Neutral light console surface.", icon: Sun },
    { value: "dark", label: "Dark", description: "Neutral dark console surface.", icon: Moon },
  ];
  const resolved = $derived(mode.current ?? null);
</script>

<PageHeader title="Appearance" subtitle="One neutral visual language in light, dark, or system mode." />
<section class="setting-boundary max-w-2xl">
  <div class="setting-boundary__head"><h2>Theme</h2><p>Saved to your account. Legacy pink preferences are mapped to their equivalent system, light, or dark mode.</p></div>
  {#if $themeQuery.isError}
    <p class="text-sm text-destructive">{$themeQuery.error instanceof Error ? $themeQuery.error.message : "Failed to load appearance preference."}</p>
  {:else}
    <RadioGroup value={selected} onValueChange={choose} disabled={$themeQuery.isLoading || $mutation.isPending} class="divide-y border-y">
      {#each options as option (option.value)}
        {@const Icon = option.icon}
        <Label for={`theme-${option.value}`} class="flex min-h-14 cursor-pointer items-center gap-3 px-3 hover:bg-muted/50">
          <RadioGroupItem id={`theme-${option.value}`} value={option.value} />
          <Icon class="h-4 w-4 text-muted-foreground" /><span><span class="block text-sm font-medium">{option.label}</span><span class="block text-xs text-muted-foreground">{option.description}</span></span>
        </Label>
      {/each}
    </RadioGroup>
  {/if}
  {#if resolved}<p class="mt-3 text-xs text-muted-foreground">Rendering in <span class="font-medium text-foreground">{resolved}</span> mode.</p>{/if}
</section>
