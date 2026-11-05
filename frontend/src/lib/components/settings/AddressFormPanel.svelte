<script lang="ts">
  /**
   * Fleet-wide formal ("Sie") or informal ("du") address. Rendered into every
   * engine's served instructions — see api/src/services/agent-address-form.ts.
   */
  import * as Card from "$lib/components/ui/card";
  import type { AddressFormOption } from "$lib/api/agents";

  type Form = "informal" | "formal";
  type Props = { form: Form; options: AddressFormOption[]; disabled?: boolean; onChange: (form: Form) => void };
  let { form, options, disabled = false, onChange }: Props = $props();

  const fallback: AddressFormOption[] = [
    { form: "informal", label: "Informal (du)", description: "Address the user informally." },
    { form: "formal", label: "Formal (Sie)", description: "Address the user formally." },
  ];
  const choices = $derived(options.length ? options : fallback);
</script>

<Card.Root>
  <Card.Content class="space-y-3 p-4">
    <fieldset class="space-y-2" {disabled}>
      <legend class="space-y-1">
        <span class="block text-sm font-semibold">Form of address</span>
        <span class="block text-xs font-normal text-muted-foreground">
          How agents address you in languages that distinguish it (German du/Sie). Informal is the default; models drift to the formal form on their own, so the choice is written into every engine's instructions.
        </span>
      </legend>
      <div class="flex flex-wrap gap-4">
        {#each choices as choice (choice.form)}
          <label class="flex items-center gap-2 text-body-sm">
            <input type="radio" name="address-form" value={choice.form} checked={form === choice.form} onchange={() => onChange(choice.form)} />
            {choice.label}
          </label>
        {/each}
      </div>
    </fieldset>
  </Card.Content>
</Card.Root>
