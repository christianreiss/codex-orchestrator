import { resolve } from "node:path";
import { ManualStore } from "../../api/src/services/manual-articles";

/**
 * The manual manifest exactly as `GET /admin/manual/manifest` builds it: the
 * API walks `public/admin/manual/articles/` and reads each article's
 * frontmatter, so the fixture uses the same store instead of a checked-in copy.
 */
const store = new ManualStore(resolve(import.meta.dirname, "../../public/admin"));

export function manualManifest() {
  return store.manifest();
}
