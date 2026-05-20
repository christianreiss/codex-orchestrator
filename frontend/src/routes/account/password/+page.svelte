<script lang="ts">
  import { z } from "zod";
  import { toast } from "svelte-sonner";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import * as Card from "$lib/components/ui/card";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import { api, ApiError } from "$lib/api/client";
  import { changePassword } from "$lib/api/account";
  import { authStore } from "$lib/stores/auth";
  import Check from "@lucide/svelte/icons/check";
  import X from "@lucide/svelte/icons/x";
  import Mail from "@lucide/svelte/icons/mail";

  const passwordSchema = z
    .string()
    .min(12, "Must be at least 12 characters")
    .regex(/\d/, "Must contain a digit")
    .regex(/[^A-Za-z0-9]/, "Must contain a symbol");

  let current = $state("");
  let next = $state("");
  let confirm = $state("");
  let submitting = $state(false);
  let formError = $state<string | null>(null);
  let fieldErrors = $state<Record<string, string | undefined>>({});

  // Live confirm match (only after user has typed something in confirm)
  const matchState = $derived.by(() => {
    if (!confirm) return null;
    if (!next) return null;
    return confirm === next ? "match" : "mismatch";
  });

  // Live new-password rule checklist
  const rules = $derived([
    { label: "At least 12 characters", ok: next.length >= 12 },
    { label: "Contains a digit", ok: /\d/.test(next) },
    { label: "Contains a symbol", ok: /[^A-Za-z0-9]/.test(next) },
  ]);

  function validate(): boolean {
    fieldErrors = {};
    if (!current) {
      fieldErrors.current = "Required";
    }
    const parsed = passwordSchema.safeParse(next);
    if (!parsed.success) {
      fieldErrors.next = parsed.error.issues[0]?.message ?? "Invalid";
    }
    if (!confirm) {
      fieldErrors.confirm = "Required";
    } else if (confirm !== next) {
      fieldErrors.confirm = "Does not match";
    }
    return Object.keys(fieldErrors).length === 0;
  }

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    formError = null;
    if (!validate()) return;
    submitting = true;
    try {
      await changePassword({
        current_password: current,
        new_password: next,
        confirm_password: confirm,
      });
      toast.success("Password changed");
      current = "";
      next = "";
      confirm = "";
    } catch (err) {
      if (err instanceof ApiError) {
        formError = err.message;
      } else if (err instanceof Error) {
        formError = err.message;
      } else {
        formError = "Failed to change password.";
      }
    } finally {
      submitting = false;
    }
  }

  // Reset-by-email dialog
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
      await api.post("/admin/auth/password/request", { username });
      toast.success("Reset email sent if a recovery address is configured.");
      resetOpen = false;
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(err.message);
      } else {
        toast.error("Could not request a reset.");
      }
    } finally {
      resetSubmitting = false;
    }
  }
</script>

<PageHeader title="Password" subtitle="Change your account password" />

<div class="space-y-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>Change password</Card.Title>
      <Card.Description>
        Use a strong, unique password — at least 12 characters with a digit and a symbol.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <form class="space-y-5" onsubmit={onSubmit} novalidate>
        {#if formError}
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        {/if}

        <div class="space-y-2">
          <Label for="current">Current password</Label>
          <Input
            id="current"
            type="password"
            autocomplete="current-password"
            bind:value={current}
            aria-invalid={fieldErrors.current ? "true" : undefined}
          />
          {#if fieldErrors.current}
            <p class="text-xs text-destructive">{fieldErrors.current}</p>
          {/if}
        </div>

        <div class="space-y-2">
          <Label for="next">New password</Label>
          <Input
            id="next"
            type="password"
            autocomplete="new-password"
            bind:value={next}
            aria-invalid={fieldErrors.next ? "true" : undefined}
          />
          <ul class="mt-1 space-y-0.5 text-xs">
            {#each rules as rule (rule.label)}
              <li
                class="flex items-center gap-1.5 {rule.ok
                  ? 'text-green-600 dark:text-green-500'
                  : 'text-muted-foreground'}"
              >
                {#if rule.ok}
                  <Check class="h-3.5 w-3.5" />
                {:else}
                  <X class="h-3.5 w-3.5 opacity-50" />
                {/if}
                <span>{rule.label}</span>
              </li>
            {/each}
          </ul>
          {#if fieldErrors.next}
            <p class="text-xs text-destructive">{fieldErrors.next}</p>
          {/if}
        </div>

        <div class="space-y-2">
          <Label for="confirm">Confirm new password</Label>
          <Input
            id="confirm"
            type="password"
            autocomplete="new-password"
            bind:value={confirm}
            aria-invalid={fieldErrors.confirm ? "true" : undefined}
          />
          {#if matchState === "match"}
            <p class="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-500">
              <Check class="h-3.5 w-3.5" /> Passwords match
            </p>
          {:else if matchState === "mismatch"}
            <p class="flex items-center gap-1.5 text-xs text-destructive">
              <X class="h-3.5 w-3.5" /> Passwords do not match
            </p>
          {/if}
          {#if fieldErrors.confirm && matchState !== "mismatch"}
            <p class="text-xs text-destructive">{fieldErrors.confirm}</p>
          {/if}
        </div>

        <div class="flex justify-end">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Change password"}
          </Button>
        </div>
      </form>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title class="flex items-center gap-2 text-base">
        <Mail class="h-4 w-4 text-muted-foreground" />
        Reset by email
      </Card.Title>
      <Card.Description>
        Lost access? Send a one-time reset token to your registered admin email. A separate
        page consumes the token to set a new password.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <Button variant="outline" onclick={() => (resetOpen = true)}>
        Send reset email
      </Button>
    </Card.Content>
  </Card.Root>
</div>

<Dialog.Root bind:open={resetOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Send password reset?</Dialog.Title>
      <Dialog.Description>
        We will email a one-time token to the admin recovery address on file. Use this
        only if you have lost the ability to sign in normally.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (resetOpen = false)} disabled={resetSubmitting}>
        Cancel
      </Button>
      <Button onclick={onConfirmReset} disabled={resetSubmitting || !currentUsername}>
        {resetSubmitting ? "Sending…" : "Send reset email"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
