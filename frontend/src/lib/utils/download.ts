import { ApiError } from "$lib/api/client";

/**
 * Save a backend response to the viewer's disk.
 *
 * The obvious implementation — `<a href={url} download>` — does not work here.
 * The dev server proxies to the backend only for requests whose `Accept` marks
 * them as API calls (see `bypassNonApi` in vite.config.ts), and a browser
 * navigation cannot set that header, so a plain anchor would be answered with
 * the SPA shell in dev and silently save an HTML page. Fetching lets us send
 * `application/octet-stream`, which vite.config.ts admits alongside JSON and SSE.
 *
 * It also buys correct error handling: an anchor that hits a 403 navigates the
 * browser to an error page, while this surfaces the same `ApiError` every other
 * call in the console throws, so a missing capability reads as a toast rather
 * than as a corrupt file.
 *
 * The trade is that the whole body is buffered in memory before it is saved,
 * which is fine at the size ceiling the transfer pool enforces and would not be
 * for an arbitrary-size export.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/octet-stream" },
  });

  if (!response.ok) {
    // The failure envelope is still JSON even though the success path is bytes.
    let message = response.statusText || `Download failed (${response.status})`;
    let code: string | undefined;
    try {
      const body = (await response.json()) as { message?: string; code?: string };
      if (typeof body?.message === "string") message = body.message;
      if (typeof body?.code === "string") code = body.code;
    } catch {
      // Not JSON. Keep the status text.
    }
    throw new ApiError({ status: response.status, message, code });
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoking synchronously can race the save in some browsers, so give the
    // click a turn of the event loop first.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
