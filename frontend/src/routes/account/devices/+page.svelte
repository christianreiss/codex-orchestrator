<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import QRCode from "qrcode";
  import { toast } from "svelte-sonner";
  import { api } from "$lib/api/client";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";

  type Device = { id: string; name: string; created_at: string; last_seen_at: string; revoked_at: string | null };
  const qc = useQueryClient();
  const devices = createQuery({ queryKey: ["companion-devices"], queryFn: () => api.get<{ devices: Device[]; push_configured: boolean }>("/admin/companion/devices"), refetchInterval: 5000 });
  let open = $state(false);
  let busy = $state(false);
  let image = $state("");
  let code = $state("");
  let expires = $state(0);
  let remaining = $state(0);
  $effect(() => {
    if (!open) { image = ""; code = ""; return; }
    const tick = () => { remaining = Math.max(0, Math.ceil((expires - Date.now()) / 1000)); if (!remaining) { image = ""; code = ""; } };
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
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not create pairing code"); }
    finally { busy = false; }
  }
  async function copyCode() {
    try { await navigator.clipboard.writeText(code); toast.success("Pairing code copied"); }
    catch { toast.error("Could not copy pairing code"); }
  }
  async function revoke(device: Device) {
    busy = true;
    try {
      await api.delete(`/admin/companion/devices/${device.id}`);
      await qc.invalidateQueries({ queryKey: ["companion-devices"] });
      toast.success(`${device.name} revoked`);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not revoke device"); }
    finally { busy = false; }
  }
</script>

<div class="space-y-6">
  <PageHeader title="Android devices" subtitle="Chat with agents and review host access requests from your phone." />
  <Button onclick={pair} disabled={busy}>Pair Android device</Button>
  {#if $devices.data && !$devices.data.push_configured}
    <p class="rounded-lg border border-border p-4 text-sm text-muted-foreground">Push delivery is not configured. Pairing and chat are available; configure Firebase on the server to enable notifications.</p>
  {/if}
  {#if $devices.isError}<p role="alert">{$devices.error.message}</p>{/if}
  {#if $devices.isPending}<p>Loading devices…</p>{/if}
  <div class="space-y-3">
    {#each $devices.data?.devices ?? [] as device (device.id)}
      <div class="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div><p class="font-medium">{device.name}</p><p class="text-sm text-muted-foreground">{device.revoked_at ? "Revoked" : `Last connected ${new Date(device.last_seen_at).toLocaleString()}`}</p></div>
        {#if !device.revoked_at}<Button variant="destructive" disabled={busy} onclick={() => revoke(device)}>Revoke</Button>{/if}
      </div>
    {:else}
      {#if !$devices.isPending}<p class="text-muted-foreground">No paired devices yet.</p>{/if}
    {/each}
  </div>
</div>
<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header><Dialog.Title>Pair your phone</Dialog.Title><Dialog.Description>Open Orchestrator Companion and scan this code. It signs the phone in as your account and can be used once.</Dialog.Description></Dialog.Header>
    {#if image}<img src={image} alt="One-time Android pairing QR code" class="mx-auto w-full max-w-80 rounded-lg" />{/if}
    <p class="text-center text-sm">{remaining > 0 ? `Expires in ${remaining} seconds` : "Code expired"}</p>
    <Button variant="outline" onclick={copyCode} disabled={busy || !code}>Copy pairing code</Button>
    <Button onclick={pair} disabled={busy}>Generate a new code</Button>
  </Dialog.Content>
</Dialog.Root>
