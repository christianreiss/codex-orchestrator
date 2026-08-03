<script lang="ts">
  /**
   * The one-time first-owner claim. `POST /admin/setup/owner` issues the
   * session cookie inline, so the wizard continues straight into the
   * admin-gated steps without a login round-trip.
   *
   * Validates the 12-character floor client-side. That floor is fixed in the
   * API and has no env knob, so telling the operator before the round-trip is
   * strictly better than letting the server reject it.
   */
  import { z } from "zod";
  import { Input } from "$lib/components/ui/input";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import FormField from "$lib/components/ui/form-field/FormField.svelte";
  import { api, ApiError } from "$lib/api/client";
  import { authActions } from "$lib/stores/auth";

  type Props = {
    ownerCreated: boolean;
    onCreated: () => void;
    /** Lets Enter run the same path the wizard footer does, advance included. */
    onSubmitRequested: () => void | Promise<void>;
  };
  let { ownerCreated, onCreated, onSubmitRequested }: Props = $props();

  const schema = z.object({
    name: z.string().min(1, "Name is required"),
    username: z
      .string()
      .min(3, "At least 3 characters")
      .regex(/^[a-z0-9._-]+$/, "Lowercase letters, digits, dot, underscore and dash only"),
    email: z.string().email("Enter a valid email address"),
    password: z.string().min(12, "At least 12 characters — this floor is fixed in the API"),
  });

  let name = $state("");
  let username = $state("");
  let email = $state("");
  let password = $state("");
  let confirm = $state("");
  let errors = $state<Record<string, string>>({});
  let submitting = $state(false);
  let failure = $state<string | null>(null);

  export async function submit(): Promise<boolean> {
    if (ownerCreated) return true;
    errors = {};
    failure = null;

    const parsed = schema.safeParse({ name, username, email, password });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors[issue.path.join(".") || "_"] = issue.message;
      return false;
    }
    if (password !== confirm) {
      errors.confirm = "Passwords do not match";
      return false;
    }

    submitting = true;
    try {
      await api.post("/admin/setup/owner", parsed.data);
      await authActions.refresh();
      onCreated();
      return true;
    } catch (err) {
      failure = err instanceof ApiError ? err.message : "Owner creation failed";
      return false;
    } finally {
      submitting = false;
    }
  }
</script>

{#if ownerCreated}
  <Alert>
    <AlertTitle>Owner already exists</AlertTitle>
    <AlertDescription>
      This installation has been claimed. Continue to configure the fleet.
    </AlertDescription>
  </Alert>
{:else}
  <div class="space-y-4">
    <Alert>
      <AlertTitle>This claim happens once</AlertTitle>
      <AlertDescription>
        The endpoint is reachable without a session only while no admin exists, and closes
        permanently on success. Do not expose an unclaimed installation.
      </AlertDescription>
    </Alert>

    {#if failure}
      <Alert variant="destructive">
        <AlertTitle>Could not create the owner</AlertTitle>
        <AlertDescription>{failure}</AlertDescription>
      </Alert>
    {/if}

    <div class="grid gap-4 sm:grid-cols-2">
      <FormField id="owner-name" label="Full name" error={errors.name} required>
        <Input id="owner-name" bind:value={name} aria-invalid={errors.name ? "true" : undefined} />
      </FormField>
      <FormField id="owner-username" label="Username" error={errors.username} required>
        <Input
          id="owner-username"
          bind:value={username}
          autocomplete="username"
          aria-invalid={errors.username ? "true" : undefined}
        />
      </FormField>
      <FormField id="owner-email" label="Email" error={errors.email} required>
        <Input
          id="owner-email"
          type="email"
          bind:value={email}
          autocomplete="email"
          aria-invalid={errors.email ? "true" : undefined}
        />
      </FormField>
      <div class="hidden sm:block"></div>
      <FormField
        id="owner-password"
        label="Password"
        hint="Minimum 12 characters."
        error={errors.password}
        required
      >
        <Input
          id="owner-password"
          type="password"
          bind:value={password}
          autocomplete="new-password"
          aria-describedby={errors.password ? "owner-password-error" : "owner-password-hint"}
          aria-invalid={errors.password ? "true" : undefined}
        />
      </FormField>
      <FormField id="owner-confirm" label="Confirm password" error={errors.confirm} required>
        <Input
          id="owner-confirm"
          type="password"
          bind:value={confirm}
          autocomplete="new-password"
          aria-invalid={errors.confirm ? "true" : undefined}
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === "Enter") void onSubmitRequested();
          }}
        />
      </FormField>
    </div>

    <!--
      No submit button here on purpose. The wizard footer's Create owner button
      calls the same `submit()` and then advances; a second button that only
      did half of that left the owner created and the operator still staring at
      the form.
    -->
    <p class="text-xs text-muted-foreground">
      Press Enter or use <strong>Create owner</strong> below.
    </p>
  </div>
{/if}
