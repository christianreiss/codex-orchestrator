<script lang="ts">
  import { cn } from "$lib/utils/cn";
  import { normalizeCode } from "$lib/api/cli-auth";

  type Props = {
    value: string;
    disabled?: boolean;
    autofocus?: boolean;
    onSubmit?: () => void;
    id?: string;
    class?: string;
  };

  let {
    value = $bindable(),
    disabled = false,
    autofocus = false,
    onSubmit,
    id = "cliAuthCode",
    class: className,
  }: Props = $props();

  let inputEl: HTMLInputElement | undefined = $state();

  function handleInput(event: Event) {
    const target = event.target as HTMLInputElement;
    const normalized = normalizeCode(target.value);
    value = normalized;
    // Restore cursor to end after reformat — natural for a fixed-shape code.
    requestAnimationFrame(() => {
      if (inputEl) inputEl.setSelectionRange(normalized.length, normalized.length);
    });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit?.();
    }
  }

  function handlePaste(event: ClipboardEvent) {
    event.preventDefault();
    const text = event.clipboardData?.getData("text") ?? "";
    value = normalizeCode(text);
  }

  $effect(() => {
    if (autofocus && inputEl) inputEl.focus();
  });
</script>

<input
  bind:this={inputEl}
  {id}
  type="text"
  inputmode="text"
  autocomplete="one-time-code"
  spellcheck="false"
  autocapitalize="characters"
  maxlength={9}
  placeholder="ABCD-1234"
  aria-label="Device code"
  {value}
  {disabled}
  oninput={handleInput}
  onkeydown={handleKeydown}
  onpaste={handlePaste}
  class={cn(
    "block w-full rounded-xl border-2 border-input bg-background px-4 py-5 text-center font-mono text-3xl font-semibold uppercase tracking-[0.35em] text-foreground shadow-sm transition-colors",
    "placeholder:text-muted-foreground/40 placeholder:tracking-[0.35em] placeholder:font-normal",
    "focus-visible:border-ring focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/15",
    "disabled:cursor-not-allowed disabled:opacity-60",
    className,
  )}
/>
