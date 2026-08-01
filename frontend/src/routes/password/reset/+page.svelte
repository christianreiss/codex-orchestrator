<script lang="ts">
  import BrandMark from "$lib/components/brand/BrandMark.svelte";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Card from "$lib/components/ui/card";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import { ApiError } from "$lib/api/client";
  import { resetPassword } from "$lib/api/account";

  const token = $derived(page.url.searchParams.get("token")?.trim() ?? "");
  let newPassword = $state("");
  let confirmPassword = $state("");
  let submitting = $state(false);
  let complete = $state(false);
  let error = $state<string | null>(null);

  async function submit() {
    error = null;
    if (!token) {
      error = "This reset link is missing its token.";
      return;
    }
    if (newPassword !== confirmPassword) {
      error = "Password confirmation does not match.";
      return;
    }
    submitting = true;
    try {
      await resetPassword({
        token,
        new_password: newPassword,
        confirm_password: confirmPassword,
      });
      complete = true;
      newPassword = "";
      confirmPassword = "";
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Could not reset the password.";
    } finally {
      submitting = false;
    }
  }
</script>

<main class="standalone-surface flex min-h-full items-center justify-center px-4 py-12">
  <div class="w-full max-w-md">
    <div class="mb-6 flex items-center justify-center gap-3">
      <BrandMark class="h-10 w-10" />
      <span class="text-lg font-semibold tracking-tight">Codex Orchestrator</span>
    </div>

    <Card.Root>
      <Card.Header>
        <h1 class="text-lg font-semibold leading-tight tracking-[-0.02em]">Choose a new password</h1>
        <Card.Description>Reset links are single-use and expire after 60 minutes.</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        {#if error}
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        {/if}

        {#if complete}
          <Alert>
            <AlertDescription>Your password has been reset. You can now sign in.</AlertDescription>
          </Alert>
          <Button href={`${base}/login`} class="w-full">Return to sign in</Button>
        {:else}
          <form class="space-y-4" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
            <div class="space-y-2">
              <Label for="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autocomplete="new-password"
                minlength={12}
                required
                bind:value={newPassword}
              />
              <p class="text-xs text-muted-foreground">Use at least 12 characters.</p>
            </div>
            <div class="space-y-2">
              <Label for="confirm-password">Confirm new password</Label>
              <Input
                id="confirm-password"
                type="password"
                autocomplete="new-password"
                minlength={12}
                required
                bind:value={confirmPassword}
              />
            </div>
            <Button type="submit" class="w-full" disabled={submitting || !token}>
              {submitting ? "Resetting…" : "Reset password"}
            </Button>
          </form>
          <a
            class="block text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
            href={`${base}/login`}
          >
            Back to sign in
          </a>
        {/if}
      </Card.Content>
    </Card.Root>
  </div>
</main>
