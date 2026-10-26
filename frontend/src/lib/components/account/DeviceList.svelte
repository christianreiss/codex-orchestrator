<script lang="ts">
  import PhonePairingProgress from "./PhonePairingProgress.svelte";
  import { wsStatus } from "$lib/stores/ws-status";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  /** Paired Android companion devices: pair with a one-time QR code, revoke when lost. */
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { Badge } from "$lib/components/ui/badge";
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
  const list = $derived(($devices.data?.devices ?? []).filter((device) => !device.revoked_at));
  let open = $state(false);
  let revokeOpen = $state(false);
  let target = $state<Device | null>(null);
  let error = $state("");
  let resultMessage = $state("");
  let busy = $state(false);
  let image = $state("");
  let code = $state("");
  let expires = $state(0);
  let remaining = $state(0);
  let expectedDeviceId = $state<string | null>(null);
  let generatedAt = $state<string | null>(null);
  const pairedDevice = $derived(expectedDeviceId ? list.find((device) => device.id === expectedDeviceId && !device.revoked_at) : undefined);
  $effect(() => {
    if (pairedDevice) { image = ""; code = ""; }
  });
  $effect(() => {
    if (!open) {
      image = "";
      code = "";
      expectedDeviceId = null;
      generatedAt = null;
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
    error = "";
    resultMessage = "";
    busy = true;
    image = "";
    code = "";
    expires = 0;
    generatedAt = null;
    expectedDeviceId = null;
    open = true;
    try {
      const result = await api.post<{ qr: string; expires_at: string; device_id?: string }>("/admin/companion/pairings");
      const qrImage = await QRCode.toDataURL(result.qr, { width: 320, margin: 2, errorCorrectionLevel: "M" });
      if (!open) return;
      image = qrImage;
      generatedAt = new Date().toISOString();
      expectedDeviceId = result.device_id ?? null;
      code = result.qr;
      expires = Date.parse(result.expires_at);
      void qc.invalidateQueries({ queryKey: ["companion-devices"] });
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not create pairing code";
    } finally {
      busy = false;
    }
  }
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Pairing code copied");
    } catch {
      error = "Could not copy pairing code";
    }
  }
  async function revoke(device: Device) {
    error = "";
    resultMessage = "";
    busy = true;
    try {
      await api.delete(`/admin/companion/devices/${device.id}`);
      await qc.invalidateQueries({ queryKey: ["companion-devices"] });
      revokeOpen = false;
      resultMessage = `${device.name} revoked.`;
      toast.success(`${device.name} revoked`);
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not revoke device";
      revokeOpen = false;
    } finally {
      busy = false;
    }
  }
</script>

<div class="space-y-3">
  <div class="flex flex-wrap items-start justify-between gap-2">
    <p class="max-w-xl text-body-sm text-muted-foreground">Chats, reachable hosts, remote agent starts and host access review from your phone.</p>
    <Button size="sm" onclick={pair} disabled={busy}>Pair Android device</Button>
  </div>
  {#if error && !open}<p role="alert" class="text-body-sm text-destructive">{error}</p>{/if}
  {#if resultMessage}<p role="status" class="text-body-sm text-success">{resultMessage}</p>{/if}
  {#if $devices.data && !$devices.data.push_configured}
    <p class="text-body-sm text-muted-foreground">Push delivery is not configured. Pairing and chat are available; configure Firebase on the server to enable notifications.</p>
  {/if}
  {#if $devices.isPending}
    <StateBlock state="loading" rows={2} />
  {:else if $devices.isError}
    <StateBlock state="error" message={$devices.error.message} onRetry={() => $devices.refetch()} />
  {:else if list.length === 0}
    <StateBlock state="empty" message="No paired devices" />
  {:else}
    <ul aria-label="Paired Android devices" class="divide-y border-y">
      {#each list as device (device.id)}
        <li class="flex flex-wrap items-center justify-between gap-3 py-4">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2"><p class="break-words text-body font-medium">{device.name}</p><Badge variant="outline">Paired</Badge></div>
            <p class="text-body-sm text-muted-foreground">
              Last connected <Timestamp value={device.last_seen_at} fallback="Never connected" />
            </p>
          </div>
            <Button size="sm" variant="outline" class="text-destructive" disabled={busy} aria-label={`Revoke ${device.name}`} onclick={() => { target = device; revokeOpen = true; }}>Revoke</Button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Pair your phone</Dialog.Title>
      <Dialog.Description>{pairedDevice ? "Pairing is complete. You can close this dialog." : "Open Orchestrator Companion and scan this code. It signs the phone in as your account and can be used once."}</Dialog.Description>
    </Dialog.Header>
    {#if error}<p role="alert" class="text-body-sm text-destructive">{error}</p>{/if}
    <PhonePairingProgress {generatedAt} pairedDevice={pairedDevice ?? null} expired={Boolean(generatedAt) && remaining === 0} {busy} failed={Boolean(error) && !generatedAt} />
    {#if pairedDevice}
      <p role="status" class="text-body text-success">{pairedDevice.name} is paired and can access your account.</p>
      <Button onclick={() => (open = false)}>Done</Button>
    {:else}
      {#if image}<img src={image} alt="One-time Android pairing QR code" class="mx-auto w-full max-w-80 rounded-md" />{/if}
      {#if generatedAt}
        <p class="text-center text-body-sm">{remaining > 0 ? `Expires in ${remaining} seconds` : "Code expired"}</p>
        {#if !expectedDeviceId}<p class="text-body-sm text-muted-foreground">This server does not support pairing confirmation. Check your devices after pairing.</p>
        {:else if $devices.isError}<p role="alert" class="text-body-sm text-destructive">Could not check pairing status. {$devices.error.message}</p>
        {:else if $wsStatus !== "open"}<p class="text-body-sm text-muted-foreground">Live updates are unavailable. Check status after scanning the code.</p>{/if}
      {/if}
      <div class="flex flex-wrap gap-2">
        {#if generatedAt}<Button variant="outline" onclick={copyCode} disabled={busy || !code}>Copy pairing code</Button>{/if}
        {#if expectedDeviceId}<Button variant="outline" onclick={() => $devices.refetch()} disabled={busy || $devices.isFetching}>Check status</Button>{/if}
        <Button onclick={pair} disabled={busy}>{busy ? "Creating code…" : "Generate a new code"}</Button>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={revokeOpen}
  title={`Revoke ${target?.name ?? "device"}?`}
  description="This device will be signed out and lose access to your account. To use it again, pair it with a new code."
  confirmLabel="Revoke device"
  destructive
  {busy}
  onConfirm={() => target ? revoke(target) : undefined}
/>
