<script lang="ts">
  /**
   * The "Allow domain" control on a pending request.
   *
   * Separate from `InsecureWindowPopover` (which is a bare duration picker)
   * because allowing a domain is a wider act than extending one host's window
   * and the operator should see how much wider before they press it: the domain
   * that will be written, how many pending requests it clears, and whether the
   * allow ever lapses.
   */
  import * as Popover from "$lib/components/ui/popover";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import Globe from "@lucide/svelte/icons/globe";

  type Props = {
    /** The parent domain that will be allowed, as computed by the caller. */
    domain: string | null;
    /** How many pending requests this allow will resolve, including this one. */
    coveredCount: number;
    disabled?: boolean;
    onConfirm: (opts: { duration_minutes: number; permanent: boolean }) => void | Promise<void>;
  };

  let { domain, coveredCount, disabled = false, onConfirm }: Props = $props();

  const MIN = 5;
  const MAX = 480;
  const STEP = 5;
  /** Matches APPROVAL_WINDOW_MINUTES on the server: an approval is worth 8h. */
  const DEFAULT_MINUTES = 480;

  let open = $state(false);
  let value: number | null = $state(DEFAULT_MINUTES);
  let permanent = $state(false);
  let busy = $state(false);

  let invalid = $derived(!permanent && !Number.isFinite(value));

  $effect(() => {
    if (open) {
      value = DEFAULT_MINUTES;
      permanent = false;
    }
  });

  function clamp(n: number | null): number {
    if (!Number.isFinite(n)) return DEFAULT_MINUTES;
    const truncated = Math.trunc(n as number);
    if (truncated < MIN) return MIN;
    if (truncated > MAX) return MAX;
    return truncated;
  }

  async function apply(): Promise<void> {
    if (invalid) return;
    busy = true;
    try {
      await onConfirm({ duration_minutes: clamp(value), permanent });
      open = false;
    } finally {
      busy = false;
    }
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="outline" size="sm" {disabled}>
        <Globe class="h-3.5 w-3.5" />
        Allow domain{coveredCount > 1 ? ` (${coveredCount})` : ""}
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content class="w-80 space-y-3" align="end">
    <header class="space-y-0.5">
      <p class="text-sm font-semibold">Allow domain</p>
      <p class="text-[11px] text-muted-foreground">
        {#if domain}
          Every host under <span class="font-mono">*.{domain}</span> is admitted without a prompt.
          {#if coveredCount > 1}
            Clears {coveredCount} pending requests.
          {/if}
        {:else}
          This host has no parent domain to allow.
        {/if}
      </p>
    </header>

    <div class="space-y-1.5" class:opacity-50={permanent}>
      <Label for="allow-domain-slider">Duration: {value} min</Label>
      <input
        id="allow-domain-slider"
        type="range"
        min={MIN}
        max={MAX}
        step={STEP}
        disabled={permanent}
        bind:value
        class="block w-full accent-primary"
      />
      <Input
        type="number"
        min={MIN}
        max={MAX}
        step={STEP}
        disabled={permanent}
        bind:value
        class="h-8 text-xs"
        aria-label="Duration in minutes"
      />
    </div>

    <label class="flex items-start gap-2 text-xs">
      <input type="checkbox" bind:checked={permanent} class="mt-0.5 accent-primary" />
      <span>
        <span class="font-medium">Never expires</span>
        <span class="block text-[11px] text-muted-foreground">
          Survives a restart. Still cleared by “Disable all”.
        </span>
      </span>
    </label>

    <div class="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onclick={() => (open = false)} disabled={busy}>
        Cancel
      </Button>
      <Button size="sm" onclick={apply} disabled={busy || !domain}>
        {busy ? "Working…" : "Allow"}
      </Button>
    </div>
  </Popover.Content>
</Popover.Root>
