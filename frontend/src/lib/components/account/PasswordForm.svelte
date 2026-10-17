<script lang="ts">
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { FormField } from "$lib/components/ui/form-field";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import { ApiError } from "$lib/api/client";
  import { changePassword, requestPasswordReset } from "$lib/api/account";
  import { authStore } from "$lib/stores/auth";
  import { PASSWORD_RULES, passwordSchema } from "$lib/constants/password";
  import Check from "@lucide/svelte/icons/check";
  import X from "@lucide/svelte/icons/x";

  let current = $state("");
  let next = $state("");
  let confirm = $state("");
  let submitting = $state(false);
  let formError = $state<string | null>(null);
  let fieldErrors = $state<Record<string, string | undefined>>({});

  // Live confirm match, only once the user has typed in both fields.
  const matchState = $derived(!confirm || !next ? null : confirm === next ? "match" : "mismatch");
  const rules = $derived(PASSWORD_RULES.map((rule) => ({ label: rule.label, ok: rule.test(next) })));

  function validate(): boolean {
    fieldErrors = {};
    if (!current) fieldErrors.current = "Required";
    const parsed = passwordSchema.safeParse(next);
    if (!parsed.success) fieldErrors.next = parsed.error.issues[0]?.message ?? "Invalid";
    if (!confirm) fieldErrors.confirm = "Required";
    else if (confirm !== next) fieldErrors.confirm = "Does not match";
    return Object.keys(fieldErrors).length === 0;
  }

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    formError = null;
    if (!validate()) return;
    submitting = true;
    try {
      await changePassword({ current_password: current, new_password: next, confirm_password: confirm });
      toast.success("Password changed");
      current = next = confirm = "";
    } catch (err) {
      formError = err instanceof Error ? err.message : "Failed to change password.";
    } finally {
      submitting = false;
    }
  }

  let resetOpen = $state(false);
  let resetSubmitting = $state(false);
  const currentUsername = $derived($authStore.user?.username ?? "");

  async function onConfirmReset() {
    const username = currentUsername.trim();
    if (!username) {
      toast.error("No signed-in user.");
      return;
    }
    resetSubmitting = true;
    try {
      await requestPasswordReset({ username });
      toast.success("Reset email sent if a recovery address is configured.");
      resetOpen = false;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not request a reset.");
    } finally {
      resetSubmitting = false;
    }
  }
</script>

<form class="max-w-md space-y-3" onsubmit={onSubmit} novalidate aria-label="Change password">
  {#if formError}
    <Alert variant="destructive"><AlertDescription>{formError}</AlertDescription></Alert>
  {/if}

  <FormField id="current" label="Current password" error={fieldErrors.current}>
    <Input id="current" type="password" autocomplete="current-password" bind:value={current} aria-invalid={fieldErrors.current ? "true" : undefined} />
  </FormField>

  <FormField id="next" label="New password" error={fieldErrors.next}>
    <Input id="next" type="password" autocomplete="new-password" bind:value={next} aria-invalid={fieldErrors.next ? "true" : undefined} />
    <ul class="mt-1 space-y-0.5 text-caption">
      {#each rules as rule (rule.label)}
        <li class="flex items-center gap-1.5 {rule.ok ? 'text-success' : 'text-muted-foreground'}">
          {#if rule.ok}<Check class="h-3.5 w-3.5" />{:else}<X class="h-3.5 w-3.5 opacity-50" />{/if}
          <span>{rule.label}</span>
        </li>
      {/each}
    </ul>
  </FormField>

  <FormField id="confirm" label="Confirm new password" error={matchState === "mismatch" ? undefined : fieldErrors.confirm}>
    <Input id="confirm" type="password" autocomplete="new-password" bind:value={confirm} aria-invalid={fieldErrors.confirm ? "true" : undefined} />
    {#if matchState === "match"}
      <p class="flex items-center gap-1.5 text-caption text-success"><Check class="h-3.5 w-3.5" /> Passwords match</p>
    {:else if matchState === "mismatch"}
      <p class="flex items-center gap-1.5 text-caption text-destructive"><X class="h-3.5 w-3.5" /> Passwords do not match</p>
    {/if}
  </FormField>

  <div class="flex flex-wrap items-center gap-2">
    <Button type="submit" disabled={submitting}>{submitting ? "Saving…" : "Change password"}</Button>
    <Button type="button" variant="ghost" onclick={() => (resetOpen = true)}>Lost access? Reset by email</Button>
  </div>
</form>

<ConfirmDialog
  bind:open={resetOpen}
  title="Send password reset?"
  description="We will email a one-time token to the admin recovery address on file. Use this only if you have lost the ability to sign in normally."
  confirmLabel={currentUsername ? "Send reset email" : "No signed-in user"}
  busy={resetSubmitting}
  onConfirm={onConfirmReset}
/>
