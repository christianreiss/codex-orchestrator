<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { cn } from "$lib/utils/cn";
  import { z } from "zod";
  import {
    createUserSchema,
    editUserSchema,
    ROLE_OPTIONS,
  } from "./userSchema";
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
    const payload: AdminUserPayload = {
      name: data.name || undefined,
      username: data.username,
      email: data.email || undefined,
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

<Dialog.Root open={open} onOpenChange={onOpenChange}>
  <Dialog.Content class="sm:max-w-[480px]">
    <Dialog.Header>
      <Dialog.Title>{isEdit ? "Edit user" : "Add user"}</Dialog.Title>
      <Dialog.Description>
        {isEdit
          ? "Update the account details. Leave password fields blank to keep it unchanged."
          : "Create a new admin account."}
      </Dialog.Description>
    </Dialog.Header>

    <form class="space-y-4" onsubmit={submit}>
      <div class="space-y-1.5">
        <Label for="user-name">Name <span class="text-muted-foreground">(optional)</span></Label>
        <Input id="user-name" autocomplete="name" bind:value={name} disabled={submitting} />
        {#if errors.name}<p class="text-xs text-destructive">{errors.name}</p>{/if}
      </div>

      <div class="space-y-1.5">
        <Label for="user-username">Username</Label>
        <Input
          id="user-username"
          autocomplete="username"
          bind:value={username}
          placeholder="lowercase, 3-64 chars"
          disabled={submitting}
          aria-invalid={errors.username ? "true" : undefined}
        />
        {#if errors.username}<p class="text-xs text-destructive">{errors.username}</p>{/if}
      </div>

      <div class="space-y-1.5">
        <Label for="user-email">Email <span class="text-muted-foreground">(optional)</span></Label>
        <Input
          id="user-email"
          type="email"
          autocomplete="email"
          bind:value={email}
          disabled={submitting}
          aria-invalid={errors.email ? "true" : undefined}
        />
        {#if errors.email}<p class="text-xs text-destructive">{errors.email}</p>{/if}
      </div>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="space-y-1.5">
          <Label for="user-role">Role</Label>
          <Select.Root type="single" value={access_level} onValueChange={(v) => (access_level = v as UserRole)}>
            <Select.Trigger id="user-role" disabled={submitting}>
              <span>{selectedRoleLabel}</span>
            </Select.Trigger>
            <Select.Content>
              {#each ROLE_OPTIONS as opt (opt.value)}
                <Select.Item value={opt.value} label={opt.label}>{opt.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          {#if errors.access_level}<p class="text-xs text-destructive">{errors.access_level}</p>{/if}
        </div>

        <div class="space-y-1.5">
          <Label for="user-active">Active</Label>
          <div class="flex h-10 items-center gap-3 rounded-md border border-input bg-background px-3">
            <Switch
              id="user-active"
              checked={active}
              onCheckedChange={(v) => (active = Boolean(v))}
              disabled={submitting}
            />
            <span class="text-sm text-muted-foreground">
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
          <p class="text-xs text-destructive">{errors.password}</p>
        {:else}
          <p class="text-xs text-muted-foreground">
            Minimum 12 characters; mix at least two of lowercase, uppercase, digit, symbol.
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
        />
        {#if errors.password_confirm}
          <p class={cn("text-xs", "text-destructive")}>{errors.password_confirm}</p>
        {:else if passwordsMatch}
          <p class="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
            <Check class="h-3 w-3" /> Passwords match
          </p>
        {:else if passwordsMismatch}
          <p class="inline-flex items-center gap-1 text-xs text-destructive">
            <AlertCircle class="h-3 w-3" /> Passwords do not match
          </p>
        {/if}
      </div>

      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : isEdit ? "Save changes" : "Create user"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
