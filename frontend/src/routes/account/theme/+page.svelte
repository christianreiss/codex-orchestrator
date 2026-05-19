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
  import { setTheme as setLocalTheme, type ThemeChoice } from "$lib/stores/theme";
  import Sun from "@lucide/svelte/icons/sun";
  import Moon from "@lucide/svelte/icons/moon";
  import Monitor from "@lucide/svelte/icons/monitor";

  const qc = useQueryClient();

  // Server-persisted theme preference.
  const themeQuery = createQuery({
    queryKey: accountKeys.theme,
    queryFn: () => getTheme(),
  });

  // Track the radio selection locally so the UI is responsive while a save
  // is in flight. Seeded from the server fetch once it arrives.
  let selected = $state<AccountTheme>("auto");
  let seeded = $state(false);
  $effect(() => {
    const t = $themeQuery.data?.theme;
    if (!seeded && (t === "auto" || t === "light" || t === "dark")) {
      selected = t;
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
      if (t === "auto" || t === "light" || t === "dark") selected = t;
    },
  });

  function onChange(next: string) {
    if (next !== "auto" && next !== "light" && next !== "dark") return;
    const value = next as AccountTheme;
    if (value === selected && seeded) return;
    selected = value;
    // Apply locally first so the UI updates instantly even if the request fails.
    setLocalTheme(toLocal(value));
    $themeMutation.mutate(value);
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
</div>
