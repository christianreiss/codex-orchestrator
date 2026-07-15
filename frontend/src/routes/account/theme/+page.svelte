<script lang="ts">
  import { toast } from "svelte-sonner";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { mode } from "mode-watcher";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import * as Card from "$lib/components/ui/card";
  import { Label } from "$lib/components/ui/label";
  import { RadioGroup, RadioGroupItem } from "$lib/components/ui/radio-group";
  import { ApiError } from "$lib/api/client";
  import { accountKeys, getTheme, setTheme, type AccountTheme } from "$lib/api/account";
  import { setPalette, setTheme as setLocalTheme, type ThemeChoice } from "$lib/stores/theme";
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
  type BaseTheme = "auto" | "light" | "dark";
  const PRESETS: ReadonlyArray<Preset> = ["auto-pink", "bright-pink", "dark-pink"];
  const PRESET_META: Record<Preset, { label: string; description: string; swatch: string }> = {
    "auto-pink": {
      label: "Auto Pink",
      description: "Pink accents that follow the system mode.",
      swatch: "from-pink-400 to-fuchsia-600",
    },
    "bright-pink": {
      label: "Bright Pink",
      description: "A bright canvas with vivid pink controls.",
      swatch: "from-rose-300 to-pink-500",
    },
    "dark-pink": {
      label: "Dark Pink",
      description: "A deep berry canvas with soft pink accents.",
      swatch: "from-fuchsia-700 to-pink-400",
    },
  };
  const isPreset = (v: string | undefined): v is Preset =>
    v === "auto-pink" || v === "bright-pink" || v === "dark-pink";
  const isBase = (v: string | undefined): v is BaseTheme =>
    v === "auto" || v === "light" || v === "dark";

  function presetBase(p: Preset): BaseTheme {
    return p === "auto-pink" ? "auto" : p === "bright-pink" ? "light" : "dark";
  }

  function applyBodyTheme(value: string) {
    if (isPreset(value)) {
      setPalette(value);
    } else {
      setPalette(null);
    }
  }

  // Track the radio selection locally so the UI is responsive while a save
  // is in flight. Seeded from the server fetch once it arrives.
  let selected = $state<BaseTheme>("auto");
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
  function toLocal(theme: BaseTheme): ThemeChoice {
    return theme === "auto" ? "system" : theme;
  }

  const themeMutation = createMutation({
    mutationFn: (value: BaseTheme) => setTheme(value),
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
      } else {
        // Server state unknown (e.g. the initial fetch never succeeded) —
        // don't leave the optimistic, unsaved selection looking applied.
        seeded = false;
        selected = "auto";
        activePreset = null;
        applyBodyTheme("auto");
      }
    },
  });

  function onChange(next: string) {
    if (next !== "auto" && next !== "light" && next !== "dark") return;
    const value = next as BaseTheme;
    if (value === selected && seeded && activePreset === null) return;
    selected = value;
    activePreset = null;
    applyBodyTheme(value);
    // Apply locally first so the UI updates instantly even if the request fails.
    setLocalTheme(toLocal(value));
    $themeMutation.mutate(value);
  }

  const presetMutation = createMutation({
    mutationFn: (value: Preset) => setTheme(value),
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
      } else {
        // Server state unknown (e.g. the initial fetch never succeeded) —
        // don't leave the optimistic, unsaved selection looking applied.
        seeded = false;
        selected = "auto";
        activePreset = null;
        applyBodyTheme("auto");
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

  const options: Array<{
    value: BaseTheme;
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
      {#if $themeQuery.isError}
        <p class="text-sm text-destructive">
          {$themeQuery.error instanceof Error
            ? $themeQuery.error.message
            : "Failed to load theme preference."}
        </p>
      {:else}
        <RadioGroup
          value={selected}
          onValueChange={onChange}
          disabled={$themeQuery.isLoading || $themeMutation.isPending || $presetMutation.isPending}
          class="grid gap-3"
        >
          {#each options as opt (opt.value)}
            {@const Icon = opt.icon}
            {@const id = `theme-${opt.value}`}
            <Label
              for={id}
              class="flex cursor-pointer items-start gap-3 rounded-xl border bg-background p-4 transition-all hover:border-foreground/20 hover:bg-accent/35 has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-accent/70 has-[[data-state=checked]]:shadow-sm"
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
      {/if}

      {#if resolved}
        <p class="mt-4 text-xs text-muted-foreground">
          Currently rendering in <span class="font-medium text-foreground">{resolved}</span> mode.
        </p>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Pink palettes</Card.Title>
      <Card.Description>
        Optional branded palettes with a pink accent and a coordinated canvas.
      </Card.Description>
    </Card.Header>
    <Card.Content class="grid gap-3 sm:grid-cols-3">
      {#each PRESETS as preset (preset)}
        <button
          type="button"
          data-theme-option={preset}
          aria-pressed={activePreset === preset}
          class={cn(
            "group flex min-h-24 flex-col items-start rounded-xl border bg-background p-3 text-left transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md",
            activePreset === preset && "border-primary/50 bg-accent/60 text-foreground shadow-sm",
          )}
          disabled={$themeQuery.isLoading ||
            $themeQuery.isError ||
            $presetMutation.isPending ||
            $themeMutation.isPending}
          onclick={() => onChoosePreset(preset)}
        >
          <span class="mb-3 h-7 w-12 rounded-lg bg-gradient-to-br {PRESET_META[preset].swatch} shadow-inner ring-1 ring-black/5"></span>
          <span class="text-sm font-semibold">{PRESET_META[preset].label}</span>
          <span class="mt-1 text-xs leading-relaxed text-muted-foreground">
            {PRESET_META[preset].description}
          </span>
        </button>
      {/each}
    </Card.Content>
  </Card.Root>
</div>
