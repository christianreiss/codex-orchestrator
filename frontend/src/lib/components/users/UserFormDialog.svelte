<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import * as Select from "$lib/components/ui/select";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { FormField } from "$lib/components/ui/form-field";
  import { Switch } from "$lib/components/ui/switch";
  import { cn } from "$lib/utils/cn";
  import { z } from "zod";
  import {
    createUserSchema,
    editUserSchema,
    ROLE_OPTIONS,
  } from "./userSchema";
  import { PASSWORD_POLICY_TEXT } from "$lib/constants/password";
  import { USER_ROLES, type AdminUser, type AdminUserPayload, type UserRole } from "$lib/api/types";
  import Eye from "@lucide/svelte/icons/eye";
  import EyeOff from "@lucide/svelte/icons/eye-off";
  import Check from "@lucide/svelte/icons/check";
  import AlertCircle from "@lucide/svelte/icons/alert-circle";

  type Mode = "create" | "edit";

  type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: Mode;
    initial?: AdminUser | null;
    submitting?: boolean;
    onSubmit: (payload: AdminUserPayload) => void | Promise<void>;
  };

  let { open, onOpenChange, mode, initial, submitting = false, onSubmit }: Props = $props();

  const isEdit = $derived(mode === "edit");

  // Local form state -------------------------------------------------------
  let name = $state("");
  let username = $state("");
  let email = $state("");
  let access_level = $state<UserRole>("user");
  let active = $state(true);
  let password = $state("");
  let passwordConfirm = $state("");
  let showPassword = $state(false);

  /**
   * `access_level` arrives as a free-form string. Keep the row's own role
   * whenever the server still accepts it — falling back to "user" here would
   * silently demote the subject on save. Only a role the API no longer lists
   * (or a create, with no subject) starts at "user".
   */
  function seedRole(level: string | null | undefined): UserRole {
    return (USER_ROLES as readonly string[]).includes(level ?? "")
      ? (level as UserRole)
      : "user";
  }

  // Reset whenever the dialog opens with a new initial subject.
  $effect(() => {
    if (open) {
      name = initial?.name ?? "";
      username = initial?.username ?? "";
      email = initial?.email ?? "";
      access_level = seedRole(initial?.access_level);
      active = initial?.active ?? true;
      password = "";
      passwordConfirm = "";
      errors = {};
      showPassword = false;
    }
  });

  let errors = $state<Record<string, string>>({});

  // Unsaved while any field differs from the subject as opened (a typed password always counts).
  const dirty = $derived(
    open &&
      (name !== (initial?.name ?? "") ||
        username !== (initial?.username ?? "") ||
        email !== (initial?.email ?? "") ||
        access_level !== seedRole(initial?.access_level) ||
        active !== (initial?.active ?? true) ||
        password !== "" ||
        passwordConfirm !== ""),
  );

  /** Escape, overlay, X and Cancel all ask before discarding an unsaved edit. */
  function requestOpenChange(next: boolean): void {
    if (!next && (submitting || (dirty && !window.confirm(isEdit ? "Discard your changes to this person?" : "Discard the new person?")))) return;
    onOpenChange(next);
  }

  // Real-time confirmation hint -------------------------------------------
  const passwordsEntered = $derived(password.length > 0 || passwordConfirm.length > 0);
  const passwordsMatch = $derived(
    passwordsEntered && password === passwordConfirm && password.length > 0,
  );
  const passwordsMismatch = $derived(passwordsEntered && password !== passwordConfirm);

  function validate(): { ok: boolean; data?: AdminUserPayload } {
    const schema = isEdit ? editUserSchema : createUserSchema;
    const parsed = schema.safeParse({
      name,
      username: username.toLowerCase().trim(),
      email,
      access_level,
      active,
      password,
      password_confirm: passwordConfirm,
    });
    if (!parsed.success) {
      const map: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0]?.toString() ?? "_";
        if (!map[key]) map[key] = issue.message;
      }
      errors = map;
      return { ok: false };
    }
    errors = {};
    const data = parsed.data;
    // Create must carry both: the server rejects a blank name or email. Edit
    // patches, so a field left blank is omitted rather than sent as empty.
    const payload: AdminUserPayload = {
      name: isEdit ? data.name || undefined : data.name,
      username: data.username,
      email: isEdit ? data.email || undefined : data.email,
      access_level: data.access_level,
      active: data.active,
    };
    if (data.password) payload.password = data.password;
    return { ok: true, data: payload };
  }

  async function submit(event: Event) {
    event.preventDefault();
    const { ok, data } = validate();
    if (!ok || !data) return;
    await onSubmit(data);
  }

  const selectedRoleLabel = $derived(
    ROLE_OPTIONS.find((r) => r.value === access_level)?.label ?? "Pick a role",
  );
</script>

<DraftGuard {dirty} />
<Dialog.Root bind:open={() => open, requestOpenChange}>
  <Dialog.Content size="sm">
    <Dialog.Header>
      <Dialog.Title>{isEdit ? "Edit user" : "Add user"}</Dialog.Title>
      <Dialog.Description>
        {isEdit
          ? "Update the account details. Leave password fields blank to keep it unchanged."
          : "Create a new admin account."}
      </Dialog.Description>
    </Dialog.Header>

    <form class="space-y-4" onsubmit={submit}>
      <FormField id="user-name" label="Name" error={errors.name}>
        {#snippet children(f)}
          <Input
            id="user-name"
            autocomplete="name"
            bind:value={name}
            disabled={submitting}
            aria-invalid={f.invalid}
            aria-describedby={f.describedBy}
          />
        {/snippet}
      </FormField>

      <FormField id="user-username" label="Username" error={errors.username}>
        {#snippet children(f)}
          <Input
            id="user-username"
            autocomplete="username"
            bind:value={username}
            placeholder="lowercase, 3-64 chars"
            disabled={submitting}
            aria-invalid={f.invalid}
            aria-describedby={f.describedBy}
          />
        {/snippet}
      </FormField>

      <FormField id="user-email" label="Email" error={errors.email}>
        {#snippet children(f)}
          <Input
            id="user-email"
            type="email"
            autocomplete="email"
            bind:value={email}
            disabled={submitting}
            aria-invalid={f.invalid}
            aria-describedby={f.describedBy}
          />
        {/snippet}
      </FormField>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField id="user-role" label="Role" error={errors.access_level}>
          {#snippet children(f)}
            <Select.Root type="single" value={access_level} onValueChange={(v) => (access_level = v as UserRole)}>
              <Select.Trigger
                id="user-role"
                disabled={submitting}
                aria-invalid={f.invalid}
                aria-describedby={f.describedBy}
              >
                <span>{selectedRoleLabel}</span>
              </Select.Trigger>
              <Select.Content>
                {#each ROLE_OPTIONS as opt (opt.value)}
                  <Select.Item value={opt.value} label={opt.label}>{opt.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          {/snippet}
        </FormField>

        <div class="space-y-1.5">
          <Label for="user-active">Active</Label>
          <div class="flex h-9 items-center gap-3 rounded-md border border-input bg-background px-3">
            <Switch
              id="user-active"
              checked={active}
              onCheckedChange={(v) => (active = Boolean(v))}
              disabled={submitting}
            />
            <span class="text-body text-muted-foreground">
              {active ? "Account can sign in" : "Disabled"}
            </span>
          </div>
        </div>
      </div>

      <div class="space-y-1.5">
        <Label for="user-password">
          Password
          {#if isEdit}<span class="text-muted-foreground">(leave blank to keep current)</span>{/if}
        </Label>
        <div class="relative">
          <Input
            id="user-password"
            type={showPassword ? "text" : "password"}
            autocomplete={isEdit ? "new-password" : "new-password"}
            bind:value={password}
            disabled={submitting}
            class="pr-10"
            aria-invalid={errors.password ? "true" : undefined}
            aria-describedby={errors.password ? "user-password-error" : "user-password-hint"}
          />
          <button
            type="button"
            class="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onclick={() => (showPassword = !showPassword)}
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {#if showPassword}
              <EyeOff class="h-4 w-4" />
            {:else}
              <Eye class="h-4 w-4" />
            {/if}
          </button>
        </div>
        {#if errors.password}
          <p id="user-password-error" class="text-body-sm text-destructive">{errors.password}</p>
        {:else}
          <p id="user-password-hint" class="text-body-sm text-muted-foreground">
            {PASSWORD_POLICY_TEXT}
          </p>
        {/if}
      </div>

      <div class="space-y-1.5">
        <Label for="user-password-confirm">Confirm password</Label>
        <Input
          id="user-password-confirm"
          type={showPassword ? "text" : "password"}
          autocomplete="new-password"
          bind:value={passwordConfirm}
          disabled={submitting}
          aria-invalid={errors.password_confirm || passwordsMismatch ? "true" : undefined}
          aria-describedby={errors.password_confirm || passwordsMatch || passwordsMismatch ? "user-password-confirm-status" : undefined}
        />
        {#if errors.password_confirm}
          <p id="user-password-confirm-status" class={cn("text-body-sm", "text-destructive")}>{errors.password_confirm}</p>
        {:else if passwordsMatch}
          <p id="user-password-confirm-status" class="inline-flex items-center gap-1 text-body-sm text-success">
            <Check class="h-3 w-3" /> Passwords match
          </p>
        {:else if passwordsMismatch}
          <p id="user-password-confirm-status" class="inline-flex items-center gap-1 text-body-sm text-destructive">
            <AlertCircle class="h-3 w-3" /> Passwords do not match
          </p>
        {/if}
      </div>

      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => requestOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : isEdit ? "Save changes" : "Create user"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
