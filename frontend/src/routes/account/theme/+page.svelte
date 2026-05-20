<script lang="ts">
  import { toast } from "svelte-sonner";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { mode } from "mode-watcher";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import * as Card from "$lib/components/ui/card";
  import { Label } from "$lib/components/ui/label";
  import { RadioGroup, RadioGroupItem } from "$lib/components/ui/radio-group";
  import { api, ApiError } from "$lib/api/client";
  import { accountKeys, getTheme, setTheme, type AccountTheme, type ThemeResponse } from "$lib/api/account";
  import { setTheme as setLocalTheme, type ThemeChoice } from "$lib/stores/theme";
  import { cn } from "$lib/utils/cn";
  import Sun from "@lucide/svelte/icons/sun";
  import Moon from "@lucide/svelte/icons/moon";
  import Monitor from "@lucide/svelte/icons/monitor";

  const qc = useQueryClient();

  // Server-persisted theme preference.
  const themeQuery = createQuery({
    queryKey: accountKeys.theme,
    queryFn: () => getTheme(),
  });

  // Server-side accent presets layered on top of the base light/dark mode.
  // The base mode is derived from the preset name so mode-watcher follows.
  type Preset = "auto-pink" | "bright-pink" | "dark-pink";
  const PRESETS: ReadonlyArray<Preset> = ["auto-pink", "bright-pink", "dark-pink"];
  const isPreset = (v: string | undefined): v is Preset =>
    v === "auto-pink" || v === "bright-pink" || v === "dark-pink";
  const isBase = (v: string | undefined): v is AccountTheme =>
    v === "auto" || v === "light" || v === "dark";

  function presetBase(p: Preset): AccountTheme {
    return p === "auto-pink" ? "auto" : p === "bright-pink" ? "light" : "dark";
  }

  function applyBodyTheme(value: string) {
    if (typeof document === "undefined") return;
    if (isPreset(value)) {
      document.body.setAttribute("data-theme", value);
    } else {
      document.body.removeAttribute("data-theme");
    }
  }

  // Track the radio selection locally so the UI is responsive while a save
  // is in flight. Seeded from the server fetch once it arrives.
  let selected = $state<AccountTheme>("auto");
  let activePreset = $state<Preset | null>(null);
  let seeded = $state(false);
  $effect(() => {
    const t = $themeQuery.data?.theme;
    if (seeded || !t) return;
    if (isBase(t)) {
      selected = t;
      activePreset = null;
      seeded = true;
    } else if (isPreset(t)) {
      activePreset = t;
      selected = presetBase(t);
      applyBodyTheme(t);
      seeded = true;
    }
  });

  // Map between server vocabulary ("auto") and mode-watcher ("system").
  function toLocal(theme: AccountTheme): ThemeChoice {
    return theme === "auto" ? "system" : theme;
  }

  const themeMutation = createMutation({
    mutationFn: (value: AccountTheme) => setTheme(value),
    onSuccess: (_data, value) => {
      void qc.invalidateQueries({ queryKey: accountKeys.theme });
      toast.success(
        value === "auto"
          ? "Theme set to follow system"
          : value === "light"
            ? "Theme set to light"
            : "Theme set to dark",
      );
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError ? err.message : "Could not save theme preference.",
      );
      // Roll back to what the server last reported.
      const t = $themeQuery.data?.theme;
      if (isBase(t)) {
        selected = t;
        activePreset = null;
        applyBodyTheme(t);
      } else if (isPreset(t)) {
        activePreset = t;
        selected = presetBase(t);
        applyBodyTheme(t);
      }
    },
  });

  function onChange(next: string) {
    if (next !== "auto" && next !== "light" && next !== "dark") return;
    const value = next as AccountTheme;
    if (value === selected && seeded && activePreset === null) return;
    selected = value;
    activePreset = null;
    applyBodyTheme(value);
    // Apply locally first so the UI updates instantly even if the request fails.
    setLocalTheme(toLocal(value));
    $themeMutation.mutate(value);
  }

  const presetMutation = createMutation({
    mutationFn: (value: Preset) =>
      api.post<ThemeResponse>("/admin/theme", { theme: value }),
    onSuccess: (_data, value) => {
      void qc.invalidateQueries({ queryKey: accountKeys.theme });
      toast.success(
        value === "auto-pink"
          ? "Auto Pink applied"
          : value === "bright-pink"
            ? "Bright Pink applied"
            : "Dark Pink applied",
      );
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError ? err.message : "Could not save theme preference.",
      );
      const t = $themeQuery.data?.theme;
      if (isPreset(t)) {
        activePreset = t;
        selected = presetBase(t);
        applyBodyTheme(t);
      } else if (isBase(t)) {
        activePreset = null;
        selected = t;
        applyBodyTheme(t);
      }
    },
  });

  function onChoosePreset(value: Preset) {
    if (activePreset === value) return;
    activePreset = value;
    selected = presetBase(value);
    applyBodyTheme(value);
    setLocalTheme(toLocal(presetBase(value)));
    $presetMutation.mutate(value);
  }

  function presetLabel(p: Preset): string {
    return p === "auto-pink" ? "Auto Pink" : p === "bright-pink" ? "Bright Pink" : "Dark Pink";
  }

  const options: Array<{
    value: AccountTheme;
    label: string;
    description: string;
    icon: typeof Sun;
  }> = [
    {
      value: "auto",
      label: "Auto",
      description: "Follow the operating system's light or dark preference.",
      icon: Monitor,
    },
    {
      value: "light",
      label: "Light",
      description: "Bright background with dark text.",
      icon: Sun,
    },
    {
      value: "dark",
      label: "Dark",
      description: "Dark background with light text.",
      icon: Moon,
    },
  ];

  const resolved = $derived(mode.current ?? null);
</script>

<PageHeader title="Theme" subtitle="Choose how the admin UI looks on this account." />

<div class="space-y-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>Appearance</Card.Title>
      <Card.Description>
        Saved on the server so the same preference follows you between browsers.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <RadioGroup
        value={selected}
        onValueChange={onChange}
        disabled={$themeQuery.isLoading || $themeMutation.isPending}
        class="grid gap-3"
      >
        {#each options as opt (opt.value)}
          {@const Icon = opt.icon}
          {@const id = `theme-${opt.value}`}
          <Label
            for={id}
            class="flex cursor-pointer items-start gap-3 rounded-md border bg-background p-3 transition-colors hover:bg-accent/40 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent/60"
          >
            <RadioGroupItem {id} value={opt.value} class="mt-1" />
            <Icon class="mt-0.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span class="flex flex-col gap-0.5">
              <span class="text-sm font-medium leading-none">{opt.label}</span>
              <span class="text-xs text-muted-foreground">{opt.description}</span>
            </span>
          </Label>
        {/each}
      </RadioGroup>

      {#if resolved}
        <p class="mt-4 text-xs text-muted-foreground">
          Currently rendering in <span class="font-medium text-foreground">{resolved}</span> mode.
        </p>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Colour presets</Card.Title>
      <Card.Description>
        Apply a colour accent on top of your light/dark preference.
      </Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-wrap gap-2">
      {#each PRESETS as preset (preset)}
        <button
          type="button"
          data-theme-option={preset}
          aria-pressed={activePreset === preset}
          class={cn(
            "rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent/40",
            activePreset === preset && "border-primary bg-accent/60 text-foreground",
          )}
          disabled={$themeQuery.isLoading || $presetMutation.isPending || $themeMutation.isPending}
          onclick={() => onChoosePreset(preset)}
        >{presetLabel(preset)}</button>
      {/each}
    </Card.Content>
  </Card.Root>
</div>
