<script lang="ts">
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import BrandMark from "$lib/components/brand/BrandMark.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Card from "$lib/components/ui/card";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { api, ApiError } from "$lib/api/client";
  import { getSetupStatus, type SetupStatus } from "$lib/api/setup";
  import { authActions } from "$lib/stores/auth";

  let status = $state<SetupStatus | null>(null);
  let loading = $state(true);
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let name = $state("");
  let username = $state("");
  let email = $state("");
  let password = $state("");

  async function refresh() {
    loading = true;
    error = null;
    try { status = await getSetupStatus(); }
    catch (err) { error = err instanceof Error ? err.message : "API unreachable"; }
    finally { loading = false; }
  }

  async function createOwner() {
    submitting = true;
    error = null;
    try {
      await api.post("/admin/setup/owner", { name, username, email, password });
      await authActions.refresh();
      await refresh();
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Owner creation failed";
    } finally { submitting = false; }
  }

  onMount(() => { void refresh(); });
</script>

<main class="min-h-screen bg-muted/20 px-4 py-10">
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6">
    <div class="flex items-center gap-3"><BrandMark /><div><h1 class="text-2xl font-semibold">Installation setup</h1><p class="text-sm text-muted-foreground">Infrastructure first; provider and host onboarding stay visible afterward.</p></div></div>

    {#if error}
      <Alert variant="destructive"><AlertTitle>API unreachable or setup blocked</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
      <Button variant="outline" onclick={refresh}>Retry</Button>
    {:else if loading || !status}
      <p class="text-sm text-muted-foreground">Checking installation…</p>
    {:else}
      {#each status.warnings as warning}<Alert><AlertTitle>Attention</AlertTitle><AlertDescription>{warning}</AlertDescription></Alert>{/each}
      <Card.Root>
        <Card.Header><Card.Title>Critical infrastructure</Card.Title><Card.Description>Every item must be green before the normal console is released.</Card.Description></Card.Header>
        <Card.Content><ul class="space-y-3">{#each status.checks as check}<li class="flex items-start justify-between gap-4 text-sm"><span>{check.ok ? "✓" : "✕"} {check.label}</span><span class="text-right text-muted-foreground">{check.detail}</span></li>{/each}</ul></Card.Content>
      </Card.Root>

      {#if !status.owner_created}
        <Card.Root>
          <Card.Header><Card.Title>Create the first owner</Card.Title><Card.Description>This one-time claim creates a fixed active owner and signs it in immediately.</Card.Description></Card.Header>
          <Card.Content class="grid gap-4 sm:grid-cols-2">
            <div><Label for="name">Name</Label><Input id="name" bind:value={name} /></div>
            <div><Label for="username">Username</Label><Input id="username" bind:value={username} /></div>
            <div><Label for="email">Email</Label><Input id="email" type="email" bind:value={email} /></div>
            <div><Label for="password">Password</Label><Input id="password" type="password" bind:value={password} /></div>
          </Card.Content>
          <Card.Footer><Button disabled={submitting} onclick={createOwner}>{submitting ? "Creating…" : "Create owner"}</Button></Card.Footer>
        </Card.Root>
      {:else if status.critical_complete}
        <Card.Root>
          <Card.Header><Card.Title>Operational onboarding</Card.Title><Card.Description>These tasks do not block the console and remain here until complete.</Card.Description></Card.Header>
          <Card.Content><ul class="space-y-3">{#each status.next_actions as action}<li class="flex items-center justify-between text-sm"><span>{action.complete ? "✓" : "○"} {action.label}</span>{#if !action.complete}<Button size="sm" variant="outline" href={action.href}>{action.id.startsWith("auth_") ? "Configure" : "Open"}</Button>{/if}</li>{/each}</ul></Card.Content>
          <Card.Footer><Button href={`${base}/dashboard`}>Open console</Button></Card.Footer>
        </Card.Root>
      {/if}
    {/if}
  </div>
</main>
