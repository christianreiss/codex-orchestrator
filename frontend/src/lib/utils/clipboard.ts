import { toast } from "svelte-sonner";

export async function copyTextToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export async function autoCopyText(
  value: string,
  copiedMessage: string,
  fallbackMessage: string,
): Promise<void> {
  const copied = await copyTextToClipboard(value);
  toast.success(copied ? copiedMessage : fallbackMessage);
  if (!copied) toast.error("Auto-copy failed");
}
