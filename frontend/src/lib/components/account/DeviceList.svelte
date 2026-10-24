<script lang="ts">
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  /** Paired Android companion devices: pair with a one-time QR code, revoke when lost. */
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import QRCode from "qrcode";
  import { toast } from "svelte-sonner";
  import { api } from "$lib/api/client";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { StateBlock } from "$lib/components/page";

  type Device = { id: string; name: string; created_at: string; last_seen_at: string; revoked_at: string | null };
  const qc = useQueryClient();
  const devices = createQuery({
    queryKey: ["companion-devices"],
    queryFn: () => api.get<{ devices: Device[]; push_configured: boolean }>("/admin/companion/devices"),

  });
  const list = $derived($devices.data?.devices ?? []);
  let open = $state(false);
  let busy = $state(false);
  let image = $state("");
  let code = $state("");
  let expires = $state(0);
  let remaining = $state(0);
  $effect(() => {
    if (!open) {
      image = "";
      code = "";
      return;
    }
    const tick = () => {
      remaining = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
      if (!remaining) {
        image = "";
        code = "";
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  });
  async function pair() {
    busy = true;
    try {
      const result = await api.post<{ qr: string; expires_at: string }>("/admin/companion/pairings");
      image = await QRCode.toDataURL(result.qr, { width: 320, margin: 2, errorCorrectionLevel: "M" });
      code = result.qr;
      expires = Date.parse(result.expires_at);
      open = true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create pairing code");
    } finally {
      busy = false;
    }
  }
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Pairing code copied");
    } catch {
      toast.error("Could not copy pairing code");
    }
  }
  async function revoke(device: Device) {
    busy = true;
    try {
      await api.delete(`/admin/companion/devices/${device.id}`);
      await qc.invalidateQueries({ queryKey: ["companion-devices"] });
      toast.success(`${device.name} revoked`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not revoke device");
    } finally {
      busy = false;
    }
  }
</script>

<div class="space-y-3">
  <div class="flex flex-wrap items-start justify-between gap-2">
    <p class="max-w-xl text-body-sm text-muted-foreground">Chats, reachable hosts, remote agent starts and host access review from your phone.</p>
    <Button size="sm" variant="outline" onclick={pair} disabled={busy}>Pair Android device</Button>
  </div>
  {#if $devices.data && !$devices.data.push_configured}
    <p class="text-body-sm text-muted-foreground">Push delivery is not configured. Pairing and chat are available; configure Firebase on the server to enable notifications.</p>
  {/if}
  {#if $devices.isPending}
    <StateBlock state="loading" rows={2} />
  {:else if $devices.isError}
    <StateBlock state="error" message={$devices.error.message} onRetry={() => $devices.refetch()} />
  {:else if list.length === 0}
    <StateBlock state="empty" message="No paired devices yet" />
  {:else}
    <ul class="divide-y rounded-md border">
      {#each list as device (device.id)}
        <li class="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
          <div class="min-w-0">
            <p class="text-body font-medium">{device.name}</p>
            <p class="text-body-sm text-muted-foreground">
              {#if device.revoked_at}Revoked{:else}Last connected <time datetime={device.last_seen_at} title={new Date(device.last_seen_at).toLocaleString()}><Timestamp value={device.last_seen_at} /></time>{/if}
            </p>
          </div>
          {#if !device.revoked_at}
            <Button size="sm" variant="outline" class="text-destructive" disabled={busy} onclick={() => revoke(device)}>Revoke</Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Pair your phone</Dialog.Title>
      <Dialog.Description>Open Orchestrator Companion and scan this code. It signs the phone in as your account and can be used once.</Dialog.Description>
    </Dialog.Header>
    {#if image}<img src={image} alt="One-time Android pairing QR code" class="mx-auto w-full max-w-80 rounded-md" />{/if}
    <p class="text-center text-body-sm">{remaining > 0 ? `Expires in ${remaining} seconds` : "Code expired"}</p>
    <Button variant="outline" onclick={copyCode} disabled={busy || !code}>Copy pairing code</Button>
    <Button onclick={pair} disabled={busy}>Generate a new code</Button>
  </Dialog.Content>
</Dialog.Root>
