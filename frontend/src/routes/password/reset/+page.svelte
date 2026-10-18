<script lang="ts">
  import { page } from "$app/state";
  import BrandMark from "$lib/components/brand/BrandMark.svelte";
  import { base } from "$app/paths";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { AuthShell } from "$lib/components/page";
  import { FormField } from "$lib/components/ui/form-field";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import { ApiError } from "$lib/api/client";
  import { resetPassword } from "$lib/api/account";

  const token = $derived(page.url.searchParams.get("token")?.trim() ?? "");
  let newPassword = $state("");
  let confirmPassword = $state("");
  let submitting = $state(false);
  let complete = $state(false);
  let confirmError = $state<string | null>(null);
  let error = $state<string | null>(null);

  async function submit() {
    error = null;
    confirmError = null;
    if (!token) {
      error = "This reset link is missing its token.";
      return;
    }
    if (newPassword !== confirmPassword) {
      confirmError = "Password confirmation does not match.";
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

<AuthShell title="Choose a new password" description="Reset links are single-use and expire after 60 minutes.">
  <div class="space-y-4">
    {#if error}
      <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
    {/if}

    {#if complete}
      <Alert><AlertDescription>Your password has been reset. You can now sign in.</AlertDescription></Alert>
      <Button href={`${base}/login`} class="w-full">Return to sign in</Button>
    {:else}
      <form class="space-y-4" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
        <FormField id="new-password" label="New password" hint="Use at least 12 characters.">
          <Input id="new-password" type="password" autocomplete="new-password" minlength={12} required bind:value={newPassword} aria-describedby="new-password-hint" />
        </FormField>
        <FormField id="confirm-password" label="Confirm new password" error={confirmError ?? undefined}>
          <Input id="confirm-password" aria-invalid={!!confirmError} aria-describedby={confirmError ? "confirm-password-error" : undefined} type="password" autocomplete="new-password" minlength={12} required bind:value={confirmPassword} />
        </FormField>
        <Button type="submit" class="w-full" disabled={submitting || !token}>
          {submitting ? "Resetting…" : "Reset password"}
        </Button>
      </form>
      <a class="block text-center text-body-sm text-muted-foreground underline-offset-2 hover:underline" href={`${base}/login`}>Back to sign in</a>
    {/if}
  </div>

  {#snippet footer()}
    <p class="flex items-center justify-center gap-2 text-body-sm text-muted-foreground">
      <BrandMark class="h-5 w-5" /> Codex Orchestrator
    </p>
  {/snippet}
</AuthShell>
