import { marked } from "marked";
import DOMPurify from "dompurify";

let configured = false;

function configure(): void {
  if (configured) return;
  configured = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof HTMLAnchorElement && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

/**
 * Renders an agent message.
 *
 * `breaks: true` because this is chat, where a newline means a newline.
 *
 * The forbidden list is CSP-driven, not paranoia. `{@html}` assigns through
 * innerHTML, so any surviving `style=` attribute trips `style-src 'self'` and
 * logs a violation for every message. Remote images would fail `img-src 'self'`
 * anyway, and a stripped node reads better than a broken-image icon.
 */
export function renderMarkdown(text: string): string {
  configure();
  const raw = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "img", "form", "input", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "srcset"],
    ADD_ATTR: ["target", "rel"],
  });
}
