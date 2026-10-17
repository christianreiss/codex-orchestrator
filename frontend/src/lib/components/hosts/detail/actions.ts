import { toast } from "svelte-sonner";

/** Toast on success and failure. Reserved for irreversible or high-consequence actions. */
export async function run<T>(label: string, p: Promise<T>, opts?: { rethrow?: boolean }): Promise<void> {
  try {
    await p;
    toast.success(label);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Action failed");
    if (opts?.rethrow) throw err;
  }
}

/**
 * Toast only on error, for ordinary reversible edits: the control itself (a switch
 * flipping, a popover closing) is the success feedback. Rethrows so callers can react.
 */
export async function runQuiet<T>(p: Promise<T>): Promise<void> {
  try {
    await p;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Action failed");
    throw err;
  }
}
